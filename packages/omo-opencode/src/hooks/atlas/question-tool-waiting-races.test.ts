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
  currentResumeEpoch,
  isFailClosed,
  resetWaitingFailClosedGateForTesting,
} from "../shared/waiting-fail-closed-gate"
import { handleAtlasSessionIdle } from "./idle-event"
import { maybePromoteAtlasQuestionToolWaiting } from "./question-tool-waiting"
import {
  ATLAS_WAITING_SESSION_ID,
  createAtlasSessionState,
  createWaitingNotifierSpy,
  writeAtlasBoulder,
} from "./waiting-on-human-test-helpers.test"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"

describe("Atlas question tool waiting races", () => {
  let directory = ""

  beforeEach(() => {
    directory = join(tmpdir(), `atlas-question-tool-races-${randomUUID()}`)
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

  test("#given the question completes before the second confirmation #when Atlas idles #then it abandons promotion and continues normally", async () => {
    // given
    const planPath = join(directory, "plan.md")
    writeFileSync(planPath, "## TODOs\n- [ ] 1. Implement feature\n")
    writeAtlasBoulder(directory, planPath)
    let messagesCalls = 0
    const promptAsync = mock(async () => ({ data: {} }))
    const ctx = unsafeTestValue<PluginInput>({
      directory,
      client: {
        session: {
          messages: async () => {
            messagesCalls += 1
            return {
              data: [{
                info: { role: "assistant", finish: true },
                parts: [{
                  type: "tool",
                  callID: "call-question-race",
                  tool: "question",
                  state: { status: messagesCalls === 1 ? "pending" : "completed" },
                }],
              }],
            }
          },
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
    expect(messagesCalls).toBeGreaterThanOrEqual(2)
    expect(work?.status).toBe("active")
    expect(promptAsync).toHaveBeenCalledTimes(1)
    expect(notifications).toHaveLength(0)
  })

  test("#given question completion arrives after an enter write fails #when the closing fresh read resolves #then the fail-closed gate clears and work can continue", async () => {
    // given
    const planPath = join(directory, "plan.md")
    writeFileSync(planPath, "## TODOs\n- [ ] 1. Implement feature\n")
    writeAtlasBoulder(directory, planPath)
    const boulder = readBoulderState(directory)
    const workId = boulder?.active_work_id
    if (workId === undefined) {
      throw new Error("Expected active work")
    }
    const closingReadRequested = Promise.withResolvers<void>()
    const closingRead = Promise.withResolvers<{ data: readonly unknown[] }>()
    let messagesCalls = 0
    const ctx = unsafeTestValue<PluginInput>({
      directory,
      client: {
        session: {
          messages: async () => {
            messagesCalls += 1
            if (messagesCalls === 3) {
              closingReadRequested.resolve()
              return closingRead.promise
            }
            return {
              data: [{
                info: { role: "assistant" },
                parts: [{
                  type: "tool",
                  callID: "call-question-write-failure",
                  tool: "question",
                  state: { status: "pending" },
                }],
              }],
            }
          },
        },
      },
    })

    // when
    const promotion = maybePromoteAtlasQuestionToolWaiting({
      ctx,
      sessionID: ATLAS_WAITING_SESSION_ID,
      workId,
    }, {
      enterWaitingOnHuman: () => false,
    })
    await closingReadRequested.promise
    const armedDuringClosingRead = isFailClosed(directory, workId)
    closingRead.resolve({
      data: [{
        info: { role: "assistant" },
        parts: [{
          type: "tool",
          callID: "call-question-write-failure",
          tool: "question",
          state: { status: "completed" },
        }],
      }],
    })
    const waiting = await promotion

    // then
    expect(armedDuringClosingRead).toBeTrue()
    expect(waiting).toBeFalse()
    expect(isFailClosed(directory, workId)).toBeFalse()
    expect(getWorkById(directory, workId)?.status).toBe("active")
    expect(currentResumeEpoch(directory, workId)).toBe(1)
  })

  test("#given completion arrives during a successful enter #when promotion rechecks inside its critical section #then it resumes the work and advances the epoch", async () => {
    // given
    const planPath = join(directory, "plan.md")
    writeFileSync(planPath, "## TODOs\n- [ ] 1. Implement feature\n")
    writeAtlasBoulder(directory, planPath)
    const boulder = readBoulderState(directory)
    const workId = boulder?.active_work_id
    if (workId === undefined) {
      throw new Error("Expected active work")
    }
    let messagesCalls = 0
    const ctx = unsafeTestValue<PluginInput>({
      directory,
      client: {
        session: {
          messages: async () => {
            messagesCalls += 1
            return {
              data: [{
                info: { role: "assistant" },
                parts: [{
                  type: "tool",
                  callID: "call-question-post-enter",
                  tool: "question",
                  state: { status: messagesCalls === 3 ? "completed" : "pending" },
                }],
              }],
            }
          },
        },
      },
    })

    // when
    const waiting = await maybePromoteAtlasQuestionToolWaiting({
      ctx,
      sessionID: ATLAS_WAITING_SESSION_ID,
      workId,
    })

    // then
    expect(waiting).toBeFalse()
    expect(getWorkById(directory, workId)?.status).toBe("active")
    expect(currentResumeEpoch(directory, workId)).toBe(1)
  })
})
