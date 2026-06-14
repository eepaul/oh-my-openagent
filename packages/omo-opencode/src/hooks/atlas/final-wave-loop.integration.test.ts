import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { PluginInput } from "@opencode-ai/plugin"
import { createBoulderState, writeBoulderState } from "../../features/boulder-state"
import { _resetForTesting, registerAgentName } from "../../features/claude-code-session-state"
import { releaseAllPromptAsyncReservationsForTesting } from "../shared/prompt-async-gate"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"
import { createAtlasHook } from "./atlas-hook"
import { shouldPauseForFinalWaveApproval } from "./final-wave-approval-gate"
import {
  readFinalWaveGate,
  writeFinalWaveGate,
} from "./final-wave-gate-store"
import { readFinalWavePlanState } from "./final-wave-plan-state"

// Implementation done, one Final Verification Wave task still unchecked.
// getPlanProgress counts both sections, so this plan is NOT complete and the
// final-wave gate decision is meaningful on idle.
const FINAL_WAVE_PENDING_PLAN =
  "## TODOs\n- [x] 1. Implement feature\n\n## Final Verification Wave\n- [ ] F1. Verify everything\n"

// No Final Verification Wave section at all; all implementation tasks done.
const COMPLETE_NO_FINAL_WAVE_PLAN = "## TODOs\n- [x] 1. Implement feature\n"

// Implementation done AND the Final Verification Wave task checked -> complete.
const COMPLETE_FINAL_WAVE_CHECKED_PLAN =
  "## TODOs\n- [x] 1. Implement feature\n\n## Final Verification Wave\n- [x] F1. Verify everything\n"

const REAL_USER_TEXT_PART = { type: "text", text: "please continue the work" }
const SYNTHETIC_TEXT_PART = { type: "text", text: "internal continuation nudge", synthetic: true }

// A real user message that also carries model context. resolveRecentPromptContext
// returns early on the model (no storage-backend fallback) and the prompt-async
// gate's latest-turn inspection sees a non-synthetic user message (not blocking),
// so a genuine continuation dispatch reaches promptAsync.
const RECENT_USER_MESSAGE_WITH_MODEL = {
  id: "msg-recent-user",
  info: {
    role: "user",
    model: { providerID: "anthropic", modelID: "claude-sonnet-4" },
    time: { created: 1 },
  },
  parts: [{ type: "text", text: "go" }],
}

type AtlasEvent = { event: { type: string; properties?: unknown } }

function seedBoulder(
  directory: string,
  sessionID: string,
  planContent: string,
): { workId: string; planName: string; planPath: string } {
  const planPath = join(directory, "plan.md")
  writeFileSync(planPath, planContent)

  const boulder = createBoulderState(planPath, sessionID, "atlas")
  const workId = boulder.active_work_id
  if (!workId) {
    throw new Error("Expected active_work_id from createBoulderState")
  }
  const planName = boulder.works?.[workId]?.plan_name
  if (!planName) {
    throw new Error("Expected work plan_name from createBoulderState")
  }
  writeBoulderState(directory, boulder)

  return { workId, planName, planPath }
}

function createHarness(
  directory: string,
  messagesData: unknown[] = [],
): {
  hook: ReturnType<typeof createAtlasHook>
  promptAsync: ReturnType<typeof mock>
  messages: ReturnType<typeof mock>
} {
  const promptAsync = mock(async () => ({ data: {} }))
  const messages = mock(async () => ({ data: messagesData }))
  const ctx = unsafeTestValue<PluginInput>({
    directory,
    client: {
      session: {
        promptAsync,
        messages,
      },
    },
  })
  const hook = createAtlasHook(ctx, { directory, idleSettleMs: 0 })
  return { hook, promptAsync, messages }
}

function idleEvent(sessionID: string): AtlasEvent {
  return { event: { type: "session.idle", properties: { sessionID } } }
}

function compactedEvent(sessionID: string): AtlasEvent {
  return { event: { type: "session.compacted", properties: { sessionID } } }
}

function userMessageEvent(sessionID: string, parts: unknown[]): AtlasEvent {
  return {
    event: {
      type: "message.updated",
      properties: {
        info: { id: `msg-${randomUUID()}`, sessionID, role: "user" },
        parts,
      },
    },
  }
}

describe("atlas final-wave loop integration", () => {
  let directory = ""

  beforeEach(() => {
    directory = join(tmpdir(), `atlas-final-wave-integration-${randomUUID()}`)
    mkdirSync(join(directory, ".omo"), { recursive: true })
    _resetForTesting()
    registerAgentName("atlas")
  })

  afterEach(() => {
    if (existsSync(directory)) {
      rmSync(directory, { recursive: true, force: true })
    }
    _resetForTesting()
    releaseAllPromptAsyncReservationsForTesting()
  })

  test("1. synthetic message.updated keeps the gate and injects nothing", async () => {
    // given a session awaiting final-wave approval with a durable gate
    const sessionID = `ses-${randomUUID()}`
    const { workId, planName } = seedBoulder(directory, sessionID, FINAL_WAVE_PENDING_PLAN)
    writeFinalWaveGate(directory, {
      work_id: workId,
      plan_name: planName,
      approved_count: 0,
      pending_count: 1,
      updated_at: new Date().toISOString(),
    })
    const { hook, promptAsync } = createHarness(directory)

    // when a synthetic (internal) user message arrives
    await hook.handler(userMessageEvent(sessionID, [SYNTHETIC_TEXT_PART]))

    // then the durable gate survives and no continuation is dispatched
    expect(readFinalWaveGate(directory, workId)).not.toBeNull()
    expect(promptAsync).not.toHaveBeenCalled()
  })

  test("2. genuine user message.updated clears the gate", async () => {
    // given a session awaiting final-wave approval with a durable gate
    const sessionID = `ses-${randomUUID()}`
    const { workId, planName } = seedBoulder(directory, sessionID, FINAL_WAVE_PENDING_PLAN)
    writeFinalWaveGate(directory, {
      work_id: workId,
      plan_name: planName,
      approved_count: 0,
      pending_count: 1,
      updated_at: new Date().toISOString(),
    })
    const { hook, promptAsync } = createHarness(directory)

    // when a real, unmarked user message arrives past the compaction grace
    await hook.handler(userMessageEvent(sessionID, [REAL_USER_TEXT_PART]))

    // then the durable gate is cleared for that work and nothing is injected
    expect(readFinalWaveGate(directory, workId)).toBeNull()
    expect(promptAsync).not.toHaveBeenCalled()
  })

  test("3. session.idle re-validates the durable gate and pauses continuation", async () => {
    // given a durable gate awaiting approval on an implementation-done, final-wave-pending plan
    const sessionID = `ses-${randomUUID()}`
    const { workId, planName } = seedBoulder(directory, sessionID, FINAL_WAVE_PENDING_PLAN)
    writeFinalWaveGate(directory, {
      work_id: workId,
      plan_name: planName,
      approved_count: 0,
      pending_count: 1,
      updated_at: new Date().toISOString(),
    })
    const { hook, promptAsync } = createHarness(directory)

    // when the session idles repeatedly
    await hook.handler(idleEvent(sessionID))
    await hook.handler(idleEvent(sessionID))

    // then continuation is held and the durable gate is preserved (revalidated, not cleared)
    expect(promptAsync).not.toHaveBeenCalled()
    expect(readFinalWaveGate(directory, workId)).not.toBeNull()
  })

  test("4. session.idle without a gate does not pause; continuation is injected", async () => {
    // given an implementation-done, final-wave-pending plan with NO durable gate
    const sessionID = `ses-${randomUUID()}`
    const { workId } = seedBoulder(directory, sessionID, FINAL_WAVE_PENDING_PLAN)
    expect(readFinalWaveGate(directory, workId)).toBeNull()
    const { hook, promptAsync } = createHarness(directory, [RECENT_USER_MESSAGE_WITH_MODEL])

    // when the session idles
    await hook.handler(idleEvent(sessionID))

    // then a continuation is dispatched and no gate is fabricated
    expect(promptAsync).toHaveBeenCalled()
    expect(readFinalWaveGate(directory, workId)).toBeNull()
  })

  test("5. approval accumulator survives compaction (durable, not in SessionState)", () => {
    // given a partially-accumulated multi-task wave (2 of 4 approved) persisted in the sidecar
    const workId = "work-compaction"
    const planName = "compaction-plan"
    writeFinalWaveGate(directory, {
      work_id: workId,
      plan_name: planName,
      approved_count: 2,
      pending_count: 4,
      updated_at: new Date().toISOString(),
    })

    // when the 3rd reviewer APPROVES after compaction wiped the in-memory SessionState
    const thirdApproval = shouldPauseForFinalWaveApproval({
      directory,
      workId,
      planName,
      pendingCount: 4,
      taskOutput: "Reviewed. VERDICT: APPROVE",
      sessionState: { promptFailureCount: 0 },
    })

    // then it resumes from the durable count (3 of 4) and does not yet pause
    expect(thirdApproval).toBe(false)
    expect(readFinalWaveGate(directory, workId)?.approved_count).toBe(3)

    // when the 4th reviewer APPROVES, again with a fresh (post-compaction) SessionState
    const fourthApproval = shouldPauseForFinalWaveApproval({
      directory,
      workId,
      planName,
      pendingCount: 4,
      taskOutput: "Reviewed. VERDICT: APPROVE",
      sessionState: { promptFailureCount: 0 },
    })

    // then the wave is fully approved and the gate pauses
    expect(fourthApproval).toBe(true)
    expect(readFinalWaveGate(directory, workId)?.approved_count).toBe(4)
  })

  test("6. single final-wave task pauses immediately on APPROVE and writes the sidecar", () => {
    // given a single-task final wave and no prior gate
    const workId = "work-single"
    const planName = "single-task-plan"
    expect(readFinalWaveGate(directory, workId)).toBeNull()

    // when the lone reviewer APPROVES
    const paused = shouldPauseForFinalWaveApproval({
      directory,
      workId,
      planName,
      pendingCount: 1,
      taskOutput: "Looks correct. VERDICT: APPROVE",
      sessionState: { promptFailureCount: 0 },
    })

    // then it pauses immediately and the sidecar records the full approval
    expect(paused).toBe(true)
    const gate = readFinalWaveGate(directory, workId)
    expect(gate?.approved_count).toBe(1)
    expect(gate?.pending_count).toBe(1)
  })

  test("7. zero-final-wave plan never pauses, writes no sidecar, and completes normally", async () => {
    // given a plan with no Final Verification Wave section
    const sessionID = `ses-${randomUUID()}`
    const { workId, planName, planPath } = seedBoulder(directory, sessionID, COMPLETE_NO_FINAL_WAVE_PLAN)
    expect(readFinalWavePlanState(planPath)?.pendingFinalWaveTaskCount).toBe(0)

    // when the reviewer-edge gate is evaluated with no pending final-wave tasks
    const paused = shouldPauseForFinalWaveApproval({
      directory,
      workId,
      planName,
      pendingCount: 0,
      taskOutput: "Reviewed. VERDICT: APPROVE",
      sessionState: { promptFailureCount: 0 },
    })

    // then there is no pause and no sidecar is written
    expect(paused).toBe(false)
    expect(readFinalWaveGate(directory, workId)).toBeNull()

    // and when the complete plan idles, it completes normally (a nudge fires, still no sidecar)
    const { hook, promptAsync } = createHarness(directory)
    await hook.handler(idleEvent(sessionID))

    expect(promptAsync).toHaveBeenCalled()
    expect(readFinalWaveGate(directory, workId)).toBeNull()
  })

  test("8. real user message within the post-compaction grace window does not clear the gate", async () => {
    // given a durable gate and a stubbed clock
    const sessionID = `ses-${randomUUID()}`
    const { workId, planName } = seedBoulder(directory, sessionID, FINAL_WAVE_PENDING_PLAN)
    writeFinalWaveGate(directory, {
      work_id: workId,
      plan_name: planName,
      approved_count: 0,
      pending_count: 1,
      updated_at: new Date().toISOString(),
    })
    const { hook, promptAsync } = createHarness(directory)

    const realDateNow = Date.now
    try {
      let nowValue = 1_000_000
      globalThis.Date.now = () => nowValue

      // when compaction arms the grace window and a real user message arrives within it (< 15000ms)
      await hook.handler(compactedEvent(sessionID))
      nowValue = 1_005_000
      await hook.handler(userMessageEvent(sessionID, [REAL_USER_TEXT_PART]))
    } finally {
      globalThis.Date.now = realDateNow
    }

    // then the gate is preserved (grace prevents the clear) and nothing is injected
    expect(readFinalWaveGate(directory, workId)).not.toBeNull()
    expect(promptAsync).not.toHaveBeenCalled()
  })

  test("9. boulder completion clears the durable sidecar entry", async () => {
    // given a durable gate for a now-complete plan (implementation + final wave both done)
    const sessionID = `ses-${randomUUID()}`
    const { workId, planName } = seedBoulder(directory, sessionID, COMPLETE_FINAL_WAVE_CHECKED_PLAN)
    writeFinalWaveGate(directory, {
      work_id: workId,
      plan_name: planName,
      approved_count: 1,
      pending_count: 1,
      updated_at: new Date().toISOString(),
    })
    expect(readFinalWaveGate(directory, workId)).not.toBeNull()
    const { hook } = createHarness(directory)

    // when the completed boulder idles
    await hook.handler(idleEvent(sessionID))

    // then the sidecar entry for that work is removed
    expect(readFinalWaveGate(directory, workId)).toBeNull()
  })
})
