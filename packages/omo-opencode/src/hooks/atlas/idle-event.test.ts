import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createBoulderState, readBoulderState, writeBoulderState } from "../../features/boulder-state"
import { _resetForTesting, registerAgentName } from "../../features/claude-code-session-state"
import {
  releaseAllPromptAsyncReservationsForTesting,
  releasePromptAsyncReservation,
} from "../shared/prompt-async-gate"
import { readFinalWaveGate, writeFinalWaveGate } from "./final-wave-gate-store"
import { handleCompletedBoulderIdle } from "./idle-completion-nudge"
import { handleAtlasSessionIdle } from "./idle-event"
import type { SessionState } from "./types"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"

describe("handleAtlasSessionIdle completion nudge", () => {
  const SESSION_ID = "session-main-1"

  let testDirectory = ""

  beforeEach(() => {
    testDirectory = join(tmpdir(), `atlas-idle-complete-${randomUUID()}`)
    if (!existsSync(testDirectory)) {
      mkdirSync(testDirectory, { recursive: true })
    }
    _resetForTesting()
    registerAgentName("atlas")
  })

  afterEach(() => {
    if (existsSync(testDirectory)) {
      rmSync(testDirectory, { recursive: true, force: true })
    }
    _resetForTesting()
    releaseAllPromptAsyncReservationsForTesting()
  })

  it("sends one completion nudge per work with substituted elapsed time and task breakdown", async () => {
    // given
    const planPath = join(testDirectory, "plan.md")
    writeFileSync(planPath, "## TODOs\n- [x] 1. Parse input\n- [x] 2. Save output\n")

    const boulder = createBoulderState(planPath, SESSION_ID, "atlas")
    const workId = boulder.active_work_id
    if (!workId) {
      throw new Error("Expected active_work_id")
    }

    const work = boulder.works?.[workId]
    if (!work) {
      throw new Error("Expected active work")
    }

    work.elapsed_ms = 65_000
    boulder.elapsed_ms = 65_000
    work.task_sessions = {
      "todo:2": {
        task_key: "todo:2",
        task_label: "2",
        task_title: "Save output",
        session_id: "sub-2",
        elapsed_ms: 4_000,
        updated_at: new Date().toISOString(),
      },
      "todo:1": {
        task_key: "todo:1",
        task_label: "1",
        task_title: "Parse input",
        session_id: "sub-1",
        elapsed_ms: 61_000,
        updated_at: new Date().toISOString(),
      },
    }
    boulder.task_sessions = work.task_sessions

    writeBoulderState(testDirectory, boulder)

    const promptRequests: Array<{
      body?: {
        noReply?: boolean
        parts?: Array<{
          text?: string
          synthetic?: boolean
          metadata?: Record<string, unknown>
        }>
      }
    }> = []
    const promptAsyncMock = mock(async (request: {
      body?: {
        noReply?: boolean
        parts?: Array<{
          text?: string
          synthetic?: boolean
          metadata?: Record<string, unknown>
        }>
      }
    }) => {
      promptRequests.push(request)
      return { data: {} }
    })

    const ctx = unsafeTestValue<PluginInput>({
      directory: testDirectory,
      client: {
        session: {
          promptAsync: promptAsyncMock,
        },
      },
    })

    const sessionStateById = new Map<string, SessionState>()
    const getState = (sessionId: string): SessionState => {
      let state = sessionStateById.get(sessionId)
      if (!state) {
        state = { promptFailureCount: 0 }
        sessionStateById.set(sessionId, state)
      }
      return state
    }

    // when
    await handleAtlasSessionIdle({
      ctx,
      sessionID: SESSION_ID,
      getState,
    })

    await handleAtlasSessionIdle({
      ctx,
      sessionID: SESSION_ID,
      getState,
    })

    // then
    expect(promptAsyncMock).toHaveBeenCalledTimes(1)

    const promptText = promptRequests[0]?.body?.parts?.[0]?.text ?? ""
    expect(promptText).toContain(work.plan_name)
    expect(promptText).not.toContain("{PLAN_NAME}")
    expect(promptText).toContain("1m 5s")
    expect(promptText).toContain("1m 1s")
    expect(promptText).toContain("4s")
    expect(promptText.indexOf("Parse input")).toBeLessThan(promptText.indexOf("Save output"))
    expect(promptText).not.toContain("{ELAPSED_HUMAN}")
    expect(promptRequests[0]?.body?.noReply).toBeUndefined()
    expect(promptRequests[0]?.body?.parts?.[0]?.synthetic).toBe(true)
    expect(promptRequests[0]?.body?.parts?.[0]?.metadata?.compaction_continue).toBe(true)

    const persistedState = getState(SESSION_ID)
    expect(persistedState.boulderCompletionNudgedAt?.[workId]).toBeNumber()
    expect(readBoulderState(testDirectory)?.works?.[workId]?.status).toBe("completed")
  })

  it("#given completion nudge promptAsync may have been accepted before EOF #when idle repeats after the gate hold #then it does not send a duplicate completion nudge", async () => {
    // given
    const planPath = join(testDirectory, "plan.md")
    writeFileSync(planPath, "## TODOs\n- [x] 1. Parse input\n")

    const boulder = createBoulderState(planPath, SESSION_ID, "atlas")
    const workId = boulder.active_work_id
    if (!workId) {
      throw new Error("Expected active_work_id")
    }

    const work = boulder.works?.[workId]
    if (!work) {
      throw new Error("Expected active work")
    }
    work.elapsed_ms = 1_000
    boulder.elapsed_ms = 1_000
    writeBoulderState(testDirectory, boulder)

    const promptAsyncMock = mock(async () => {
      throw new Error("JSON Parse error: Unexpected EOF")
    })
    const ctx = unsafeTestValue<PluginInput>({
      directory: testDirectory,
      client: {
        session: {
          promptAsync: promptAsyncMock,
        },
      },
    })
    const sessionStateById = new Map<string, SessionState>()
    const getState = (sessionId: string): SessionState => {
      let state = sessionStateById.get(sessionId)
      if (!state) {
        state = { promptFailureCount: 0 }
        sessionStateById.set(sessionId, state)
      }
      return state
    }

    // when
    await handleAtlasSessionIdle({
      ctx,
      sessionID: SESSION_ID,
      getState,
    })
    const released = releasePromptAsyncReservation(SESSION_ID, "test:simulate-expired-hold", {
      reservedBy: "atlas",
    })
    await handleAtlasSessionIdle({
      ctx,
      sessionID: SESSION_ID,
      getState,
    })

    // then
    expect(released).toBe(true)
    expect(promptAsyncMock).toHaveBeenCalledTimes(1)
    expect(getState(SESSION_ID).boulderCompletionNudgedAt?.[workId]).toBeNumber()
  })

  it("does not send a completion nudge after continuation was explicitly stopped", async () => {
    // given
    const planPath = join(testDirectory, "plan.md")
    writeFileSync(planPath, "## TODOs\n- [x] 1. Parse input\n")

    const boulder = createBoulderState(planPath, SESSION_ID, "atlas")
    const workId = boulder.active_work_id
    if (!workId) {
      throw new Error("Expected active_work_id")
    }
    writeBoulderState(testDirectory, boulder)

    const promptAsyncMock = mock(async () => ({ data: {} }))
    const ctx = unsafeTestValue<PluginInput>({
      directory: testDirectory,
      client: {
        session: {
          promptAsync: promptAsyncMock,
        },
      },
    })
    const retryTimer = setTimeout(() => {}, 60_000)
    const sessionStateById = new Map<string, SessionState>([
      [SESSION_ID, { promptFailureCount: 0, pendingRetryTimer: retryTimer }],
    ])
    const getState = (sessionId: string): SessionState => {
      let state = sessionStateById.get(sessionId)
      if (!state) {
        state = { promptFailureCount: 0 }
        sessionStateById.set(sessionId, state)
      }
      return state
    }

    // when
    await handleAtlasSessionIdle({
      ctx,
      sessionID: SESSION_ID,
      getState,
      options: {
        directory: testDirectory,
        isContinuationStopped: (sessionId) => sessionId === SESSION_ID,
      },
    })

    // then
    expect(promptAsyncMock).not.toHaveBeenCalled()
    expect(getState(SESSION_ID).pendingRetryTimer).toBe(retryTimer)
    expect(getState(SESSION_ID).boulderCompletionNudgedAt?.[workId]).toBeUndefined()
    expect(readBoulderState(testDirectory)?.works?.[workId]?.status).toBe("active")
  })

  it("#given abandoned work has complete plan progress #when completion handling runs #then abandoned status is preserved", async () => {
    // given
    const planPath = join(testDirectory, "plan.md")
    writeFileSync(planPath, "## TODOs\n- [x] 1. Parse input\n")

    const boulder = createBoulderState(planPath, SESSION_ID, "atlas")
    const workId = boulder.active_work_id
    if (!workId) {
      throw new Error("Expected active_work_id")
    }

    const work = boulder.works?.[workId]
    if (!work) {
      throw new Error("Expected active work")
    }
    work.status = "abandoned"
    boulder.status = "abandoned"
    writeBoulderState(testDirectory, boulder)

    const promptAsyncMock = mock(async () => ({ data: {} }))
    const ctx = unsafeTestValue<PluginInput>({
      directory: testDirectory,
      client: {
        session: {
          promptAsync: promptAsyncMock,
        },
      },
    })
    const sessionStateById = new Map<string, SessionState>()
    const getState = (sessionId: string): SessionState => {
      let state = sessionStateById.get(sessionId)
      if (!state) {
        state = { promptFailureCount: 0 }
        sessionStateById.set(sessionId, state)
      }
      return state
    }

    // when
    await handleCompletedBoulderIdle({
      ctx,
      sessionID: SESSION_ID,
      sessionState: getState(SESSION_ID),
      boulderState: { ...boulder, status: "active" },
    })

    // then
    expect(promptAsyncMock).not.toHaveBeenCalled()
    expect(readBoulderState(testDirectory)?.works?.[workId]?.status).toBe("abandoned")
  })

  it("#given session work differs from active work #when completion handling runs #then session work is completed", async () => {
    // given
    const sessionPlanPath = join(testDirectory, "session-plan.md")
    const otherPlanPath = join(testDirectory, "other-plan.md")
    writeFileSync(sessionPlanPath, "## TODOs\n- [x] 1. Finish session work\n")
    writeFileSync(otherPlanPath, "## TODOs\n- [ ] 1. Keep working\n")

    writeBoulderState(testDirectory, {
      schema_version: 2,
      active_work_id: "work-other",
      active_plan: otherPlanPath,
      started_at: "2026-01-02T10:00:00.000Z",
      updated_at: "2026-01-02T10:00:00.000Z",
      session_ids: ["other-session"],
      plan_name: "other-plan",
      status: "active",
      works: {
        "work-session": {
          work_id: "work-session",
          active_plan: sessionPlanPath,
          plan_name: "session-plan",
          started_at: "2026-01-02T09:00:00.000Z",
          updated_at: "2026-01-02T09:00:00.000Z",
          session_ids: [SESSION_ID],
          status: "active",
          task_sessions: {},
        },
        "work-other": {
          work_id: "work-other",
          active_plan: otherPlanPath,
          plan_name: "other-plan",
          started_at: "2026-01-02T10:00:00.000Z",
          updated_at: "2026-01-02T10:00:00.000Z",
          session_ids: ["other-session"],
          status: "active",
          task_sessions: {},
        },
      },
      task_sessions: {},
    })

    const persistedBoulder = readBoulderState(testDirectory)
    if (!persistedBoulder) {
      throw new Error("Expected persisted boulder state")
    }

    const promptAsyncMock = mock(async () => ({ data: {} }))
    const ctx = unsafeTestValue<PluginInput>({
      directory: testDirectory,
      client: {
        session: {
          promptAsync: promptAsyncMock,
        },
      },
    })

    // when
    await handleCompletedBoulderIdle({
      ctx,
      sessionID: SESSION_ID,
      sessionState: { promptFailureCount: 0 },
      boulderState: {
        ...persistedBoulder,
        active_plan: sessionPlanPath,
        plan_name: "session-plan",
        session_ids: [SESSION_ID],
      },
      options: {
        directory: testDirectory,
        isContinuationStopped: (sessionId) => sessionId === SESSION_ID,
      },
    })

    // then
    const nextBoulder = readBoulderState(testDirectory)
    expect(promptAsyncMock).not.toHaveBeenCalled()
    expect(nextBoulder?.works?.["work-session"]?.status).toBe("completed")
    expect(nextBoulder?.works?.["work-other"]?.status).toBe("active")
  })

  it("#given pending background task #when session idles #then continuation waits for retry instead of prompting", async () => {
    // given
    const planPath = join(testDirectory, "plan.md")
    writeFileSync(planPath, "## TODOs\n- [ ] 1. Parse input\n")

    const boulder = createBoulderState(planPath, SESSION_ID, "atlas")
    writeBoulderState(testDirectory, boulder)

    const promptAsyncMock = mock(async () => ({ data: {} }))
    const ctx = unsafeTestValue<PluginInput>({
      directory: testDirectory,
      client: {
        session: {
          promptAsync: promptAsyncMock,
          messages: async () => ({ data: [] }),
        },
      },
    })
    const sessionStateById = new Map<string, SessionState>()
    const getState = (sessionId: string): SessionState => {
      let state = sessionStateById.get(sessionId)
      if (!state) {
        state = { promptFailureCount: 0 }
        sessionStateById.set(sessionId, state)
      }
      return state
    }

    // when
    await handleAtlasSessionIdle({
      ctx,
      sessionID: SESSION_ID,
      getState,
      options: {
        directory: testDirectory,
        backgroundManager: unsafeTestValue<NonNullable<Parameters<typeof handleAtlasSessionIdle>[0]["options"]>["backgroundManager"]>({
          getTasksByParentSession: () => [{ status: "pending" }],
        }),
      },
    })

    // then
    const sessionState = getState(SESSION_ID)
    expect(promptAsyncMock).not.toHaveBeenCalled()
    expect(sessionState.pendingRetryTimer).toBeDefined()
    if (sessionState.pendingRetryTimer) {
      clearTimeout(sessionState.pendingRetryTimer)
      sessionState.pendingRetryTimer = undefined
    }
  })
})

describe("handleAtlasSessionIdle final-wave gate", () => {
  const SESSION_ID = "session-final-wave-1"
  const FINAL_WAVE_PLAN = "## TODOs\n- [x] 1. Implement feature\n\n## Final Verification Wave\n- [ ] F1. Verify everything\n"

  let testDirectory = ""

  beforeEach(() => {
    testDirectory = join(tmpdir(), `atlas-idle-final-wave-${randomUUID()}`)
    if (!existsSync(testDirectory)) {
      mkdirSync(testDirectory, { recursive: true })
    }
    _resetForTesting()
    registerAgentName("atlas")
  })

  afterEach(() => {
    if (existsSync(testDirectory)) {
      rmSync(testDirectory, { recursive: true, force: true })
    }
    _resetForTesting()
    releaseAllPromptAsyncReservationsForTesting()
  })

  function makeGetState(): { getState: (sessionId: string) => SessionState; states: Map<string, SessionState> } {
    const states = new Map<string, SessionState>()
    const getState = (sessionId: string): SessionState => {
      let state = states.get(sessionId)
      if (!state) {
        state = { promptFailureCount: 0 }
        states.set(sessionId, state)
      }
      return state
    }
    return { getState, states }
  }

  function pendingBackgroundManager(): NonNullable<Parameters<typeof handleAtlasSessionIdle>[0]["options"]>["backgroundManager"] {
    return unsafeTestValue<NonNullable<Parameters<typeof handleAtlasSessionIdle>[0]["options"]>["backgroundManager"]>({
      getTasksByParentSession: () => [{ status: "pending" }],
    })
  }

  it("#given a durable final-wave gate awaiting approval #when the session idles repeatedly #then no continuation is injected and the mirror flag stays true", async () => {
    // given
    const planPath = join(testDirectory, "plan.md")
    writeFileSync(planPath, FINAL_WAVE_PLAN)

    const boulder = createBoulderState(planPath, SESSION_ID, "atlas")
    const workId = boulder.active_work_id
    if (!workId) {
      throw new Error("Expected active_work_id")
    }
    const planName = boulder.works?.[workId]?.plan_name
    if (!planName) {
      throw new Error("Expected work plan_name")
    }
    writeBoulderState(testDirectory, boulder)

    writeFinalWaveGate(testDirectory, {
      work_id: workId,
      plan_name: planName,
      approved_count: 0,
      pending_count: 1,
      updated_at: new Date().toISOString(),
    })

    const promptAsyncMock = mock(async () => ({ data: {} }))
    const ctx = unsafeTestValue<PluginInput>({
      directory: testDirectory,
      client: {
        session: {
          promptAsync: promptAsyncMock,
          messages: async () => ({ data: [] }),
        },
      },
    })
    const { getState } = makeGetState()

    // when
    await handleAtlasSessionIdle({ ctx, sessionID: SESSION_ID, getState })
    await handleAtlasSessionIdle({ ctx, sessionID: SESSION_ID, getState })

    // then
    expect(promptAsyncMock).not.toHaveBeenCalled()
    expect(getState(SESSION_ID).waitingForFinalWaveApproval).toBe(true)
    expect(readFinalWaveGate(testDirectory, workId)).not.toBeNull()
  })

  it("#given no durable final-wave gate #when the session idles #then continuation proceeds past the gate", async () => {
    // given
    const planPath = join(testDirectory, "plan.md")
    writeFileSync(planPath, "## TODOs\n- [ ] 1. Implement feature\n")

    const boulder = createBoulderState(planPath, SESSION_ID, "atlas")
    const workId = boulder.active_work_id
    if (!workId) {
      throw new Error("Expected active_work_id")
    }
    writeBoulderState(testDirectory, boulder)
    expect(readFinalWaveGate(testDirectory, workId)).toBeNull()

    const promptAsyncMock = mock(async () => ({ data: {} }))
    const ctx = unsafeTestValue<PluginInput>({
      directory: testDirectory,
      client: {
        session: {
          promptAsync: promptAsyncMock,
          messages: async () => ({ data: [] }),
        },
      },
    })
    const { getState } = makeGetState()

    // when
    await handleAtlasSessionIdle({
      ctx,
      sessionID: SESSION_ID,
      getState,
      options: {
        directory: testDirectory,
        backgroundManager: pendingBackgroundManager(),
      },
    })

    // then: reached the background-task gate, proving the final-wave gate did not block
    const sessionState = getState(SESSION_ID)
    expect(promptAsyncMock).not.toHaveBeenCalled()
    expect(sessionState.waitingForFinalWaveApproval).toBe(false)
    expect(sessionState.pendingRetryTimer).toBeDefined()
    if (sessionState.pendingRetryTimer) {
      clearTimeout(sessionState.pendingRetryTimer)
      sessionState.pendingRetryTimer = undefined
    }
  })

  it("#given a stale gate after implementation was reopened #when the session idles #then the gate is cleared and continuation proceeds", async () => {
    // given
    const planPath = join(testDirectory, "plan.md")
    writeFileSync(planPath, "## TODOs\n- [ ] 1. Implement feature\n\n## Final Verification Wave\n- [ ] F1. Verify everything\n")

    const boulder = createBoulderState(planPath, SESSION_ID, "atlas")
    const workId = boulder.active_work_id
    if (!workId) {
      throw new Error("Expected active_work_id")
    }
    const planName = boulder.works?.[workId]?.plan_name
    if (!planName) {
      throw new Error("Expected work plan_name")
    }
    writeBoulderState(testDirectory, boulder)

    writeFinalWaveGate(testDirectory, {
      work_id: workId,
      plan_name: planName,
      approved_count: 0,
      pending_count: 1,
      updated_at: new Date().toISOString(),
    })
    expect(readFinalWaveGate(testDirectory, workId)).not.toBeNull()

    const promptAsyncMock = mock(async () => ({ data: {} }))
    const ctx = unsafeTestValue<PluginInput>({
      directory: testDirectory,
      client: {
        session: {
          promptAsync: promptAsyncMock,
          messages: async () => ({ data: [] }),
        },
      },
    })
    const { getState } = makeGetState()

    // when
    await handleAtlasSessionIdle({
      ctx,
      sessionID: SESSION_ID,
      getState,
      options: {
        directory: testDirectory,
        backgroundManager: pendingBackgroundManager(),
      },
    })

    // then
    const sessionState = getState(SESSION_ID)
    expect(readFinalWaveGate(testDirectory, workId)).toBeNull()
    expect(promptAsyncMock).not.toHaveBeenCalled()
    expect(sessionState.waitingForFinalWaveApproval).toBe(false)
    expect(sessionState.pendingRetryTimer).toBeDefined()
    if (sessionState.pendingRetryTimer) {
      clearTimeout(sessionState.pendingRetryTimer)
      sessionState.pendingRetryTimer = undefined
    }
  })
})
