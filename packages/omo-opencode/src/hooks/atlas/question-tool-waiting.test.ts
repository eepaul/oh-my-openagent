import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { getWorkById, readBoulderState } from "../../features/boulder-state"
import { _resetForTesting, registerAgentName } from "../../features/claude-code-session-state"
import { releaseAllPromptAsyncReservationsForTesting } from "../shared/prompt-async-gate"
import {
  resetWaitingFailClosedGateForTesting,
} from "../shared/waiting-fail-closed-gate"
import { handleAtlasSessionIdle } from "./idle-event"
import {
  ATLAS_WAITING_SESSION_ID,
  createAtlasSessionState,
  createWaitingNotifierSpy,
  writeAtlasBoulder,
} from "./waiting-on-human-test-helpers.test"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"

describe("handleAtlasSessionIdle question tool waiting", () => {
  let directory = ""

  beforeEach(() => {
    directory = join(tmpdir(), `atlas-question-tool-waiting-${randomUUID()}`)
    mkdirSync(directory, { recursive: true })
    _resetForTesting()
    registerAgentName("atlas")
  })

  afterEach(() => {
    if (existsSync(directory)) {
      rmSync(directory, { recursive: true, force: true })
    }
    _resetForTesting()
    releaseAllPromptAsyncReservationsForTesting()
    resetWaitingFailClosedGateForTesting()
  })

  test("#given the latest assistant turn has a pending question call #when Atlas idles #then it persists question-tool waiting without a continuation prompt", async () => {
    // given
    const planPath = join(directory, "plan.md")
    writeFileSync(planPath, "## TODOs\n- [ ] 1. Implement feature\n")
    writeAtlasBoulder(directory, planPath)
    const promptAsync = mock(async () => ({ data: {} }))
    const ctx = unsafeTestValue<PluginInput>({
      directory,
      client: {
        session: {
          messages: async () => ({
            data: [{
              info: { role: "assistant" },
              parts: [{
                type: "tool",
                id: "part-question-not-the-call-id",
                callID: "call-question-stable",
                tool: "question",
                state: { status: "pending" },
              }],
            }],
          }),
          promptAsync,
        },
      },
    })
    const { notifier, notifications } = createWaitingNotifierSpy()

    // when
    await handleAtlasSessionIdle({
      ctx,
      sessionID: ATLAS_WAITING_SESSION_ID,
      getState: () => createAtlasSessionState(),
      options: { directory, idleSettleMs: 0, waitingOnHumanNotifier: notifier },
    })

    // then
    const boulder = readBoulderState(directory)
    const work = boulder?.active_work_id === undefined ? undefined : boulder.works?.[boulder.active_work_id]
    expect(work?.status).toBe("waiting_on_human")
    expect(work?.waiting?.source).toBe("question-tool")
    expect(work?.waiting?.question_call_id).toBe("call-question-stable")
    expect(promptAsync).not.toHaveBeenCalled()
    expect(notifications).toHaveLength(1)
  })

  for (const terminalStatus of ["completed", "error", "cancelled", "denied"] as const) {
    test(`#given a ${terminalStatus} question tool #when Atlas idles #then it follows normal continuation without promotion`, async () => {
      // given
      const planPath = join(directory, "plan.md")
      writeFileSync(planPath, "## TODOs\n- [ ] 1. Implement feature\n")
      writeAtlasBoulder(directory, planPath)
      const workId = readBoulderState(directory)?.active_work_id
      if (workId === undefined) {
        throw new Error("Expected active work")
      }
      const promptAsync = mock(async () => ({ data: {} }))
      const ctx = unsafeTestValue<PluginInput>({
        directory,
        client: {
          session: {
            messages: async () => ({
              data: [{
                info: { role: "assistant", finish: true },
                parts: [{
                  type: "tool",
                  callID: "call-question-terminal",
                  tool: "question",
                  state: { status: terminalStatus },
                }],
              }],
            }),
            promptAsync,
          },
        },
      })
      const { notifier, notifications } = createWaitingNotifierSpy()

      // when
      await handleAtlasSessionIdle({
        ctx,
        sessionID: ATLAS_WAITING_SESSION_ID,
        getState: () => createAtlasSessionState(),
        options: { directory, idleSettleMs: 0, waitingOnHumanNotifier: notifier },
      })

      // then
      expect(getWorkById(directory, workId)?.status).toBe("active")
      expect(notifications).toHaveLength(0)
    })
  }

  test("#given the question-message fetch fails #when Atlas idles #then it skips promotion and preserves the normal continuation path", async () => {
    // given
    const planPath = join(directory, "plan.md")
    writeFileSync(planPath, "## TODOs\n- [ ] 1. Implement feature\n")
    writeAtlasBoulder(directory, planPath)
    const workId = readBoulderState(directory)?.active_work_id
    if (workId === undefined) {
      throw new Error("Expected active work")
    }
    let messagesCalls = 0
    const promptAsync = mock(async () => ({ data: {} }))
    const ctx = unsafeTestValue<PluginInput>({
      directory,
      client: {
        session: {
          messages: async () => {
            messagesCalls += 1
            if (messagesCalls === 1) {
              throw new Error("message fetch failed")
            }
            return { data: [] }
          },
          promptAsync,
        },
      },
    })

    // when
    await handleAtlasSessionIdle({
      ctx,
      sessionID: ATLAS_WAITING_SESSION_ID,
      getState: () => createAtlasSessionState(),
      options: { directory, idleSettleMs: 0 },
    })

    // then
    expect(getWorkById(directory, workId)?.status).toBe("active")
    expect(promptAsync).toHaveBeenCalledTimes(1)
  })

  test("#given CLI run mode has no question tool call #when Atlas idles #then it does not promote waiting work", async () => {
    // given
    const originalCliRunMode = process.env.OPENCODE_CLI_RUN_MODE
    process.env.OPENCODE_CLI_RUN_MODE = "true"
    const planPath = join(directory, "plan.md")
    writeFileSync(planPath, "## TODOs\n- [ ] 1. Implement feature\n")
    writeAtlasBoulder(directory, planPath)
    const workId = readBoulderState(directory)?.active_work_id
    if (workId === undefined) {
      throw new Error("Expected active work")
    }
    const promptAsync = mock(async () => ({ data: {} }))
    const ctx = unsafeTestValue<PluginInput>({
      directory,
      client: {
        session: {
          messages: async () => ({ data: [] }),
          promptAsync,
        },
      },
    })
    const { notifier, notifications } = createWaitingNotifierSpy()

    // when
    try {
      await handleAtlasSessionIdle({
        ctx,
        sessionID: ATLAS_WAITING_SESSION_ID,
        getState: () => createAtlasSessionState(),
        options: { directory, idleSettleMs: 0, waitingOnHumanNotifier: notifier },
      })
    } finally {
      if (originalCliRunMode === undefined) {
        delete process.env.OPENCODE_CLI_RUN_MODE
      } else {
        process.env.OPENCODE_CLI_RUN_MODE = originalCliRunMode
      }
    }

    // then
    expect(getWorkById(directory, workId)?.status).toBe("active")
    expect(promptAsync).toHaveBeenCalledTimes(1)
    expect(notifications).toHaveLength(0)
  })
})
