import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { _resetForTesting, registerAgentName } from "../../features/claude-code-session-state"
import { releaseAllPromptAsyncReservationsForTesting } from "../shared/prompt-async-gate"
import { injectContinuation } from "./idle-continuation"
import {
  ATLAS_WAITING_SESSION_ID,
  createAtlasSessionState,
  createWaitingNotifierSpy,
  writeAtlasBoulder,
} from "./waiting-on-human-test-helpers.test"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"

describe("injectContinuation stopped guard race", () => {
  let directory = ""

  beforeEach(() => {
    directory = join(tmpdir(), `atlas-waiting-guard-${randomUUID()}`)
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
  })

  test("#given stop arrives while the prompt gate awaits messages #when the final guard runs #then no continuation or waiting reminder is dispatched", async () => {
    // given
    const planPath = join(directory, "plan.md")
    writeFileSync(planPath, "## TODOs\n- [ ] 1. Implement change\n")
    writeAtlasBoulder(directory, planPath)
    let stopped = false
    let messageCalls = 0
    let promptCalls = 0
    const gateMessagesRequested = Promise.withResolvers<void>()
    const gateMessages = Promise.withResolvers<{ data: readonly unknown[] }>()
    const { notifier, notifications } = createWaitingNotifierSpy()
    const ctx = unsafeTestValue<PluginInput>({
      directory,
      client: {
        session: {
          status: async () => ({ data: { [ATLAS_WAITING_SESSION_ID]: { type: "idle" } } }),
          messages: async () => {
            messageCalls += 1
            if (messageCalls === 1) {
              return { data: [] }
            }
            gateMessagesRequested.resolve()
            return gateMessages.promise
          },
          promptAsync: async () => {
            promptCalls += 1
          },
        },
      },
    })
    const sessionState = createAtlasSessionState()

    // when
    const injection = injectContinuation({
      ctx,
      sessionID: ATLAS_WAITING_SESSION_ID,
      sessionState,
      options: {
        directory,
        idleSettleMs: 0,
        isContinuationStopped: () => stopped,
        waitingOnHumanNotifier: notifier,
      },
      planName: "plan",
      progress: { total: 1, completed: 0 },
      agent: "atlas",
      idleSettleMs: 0,
    })
    await gateMessagesRequested.promise
    stopped = true
    gateMessages.resolve({ data: [] })
    await injection
    if (sessionState.pendingRetryTimer) {
      clearTimeout(sessionState.pendingRetryTimer)
      sessionState.pendingRetryTimer = undefined
    }

    // then
    expect(promptCalls).toBe(0)
    expect(notifications).toHaveLength(0)
  })
})
