import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createBoulderState, getWorkById, writeBoulderState } from "../../features/boulder-state"
import { createWaitingOnHumanNotifier } from "../shared/waiting-on-human-notifier"
import { createAtlasEventHandler } from "./event-handler"
import type { SessionState } from "./types"
import { createWaitingNotifierSpy } from "./waiting-on-human-test-helpers.test"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"

describe("Atlas pending question part event guards", () => {
  let directory = ""
  let sessionID = ""
  let workID = ""

  beforeEach(() => {
    directory = join(tmpdir(), `atlas-question-event-guards-${randomUUID()}`)
    mkdirSync(directory, { recursive: true })
    sessionID = `ses-${randomUUID()}`
    const planPath = join(directory, "plan.md")
    writeFileSync(planPath, "## TODOs\n- [ ] 1. Continue\n")
    const state = createBoulderState(planPath, sessionID, "atlas")
    workID = state.active_work_id ?? ""
    writeBoulderState(directory, state)
  })

  afterEach(() => {
    if (existsSync(directory)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  function questionEvent(input: { readonly sessionID: string; readonly status: string }): {
    readonly event: { readonly type: string; readonly properties: Record<string, unknown> }
  } {
    return {
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            id: "part-id-not-the-call-id",
            sessionID: input.sessionID,
            type: "tool",
            tool: "question",
            callID: "call-question-guard",
            state: { status: input.status },
          },
        },
      },
    }
  }

  function createHandler(notifier: ReturnType<typeof createWaitingNotifierSpy>["notifier"]) {
    const ctx = unsafeTestValue<PluginInput>({
      directory,
      client: {
        session: {
          messages: async () => ({
            data: [{
              info: { role: "assistant" },
              parts: [{
                type: "tool",
                callID: "call-question-guard",
                tool: "question",
                state: { status: "running" },
              }],
            }],
          }),
        },
      },
    })
    const sessions = new Map<string, SessionState>()
    const getState = (id: string): SessionState => {
      const state = sessions.get(id) ?? { promptFailureCount: 0 }
      sessions.set(id, state)
      return state
    }
    return createAtlasEventHandler({
      ctx,
      options: { directory, waitingOnHumanNotifier: notifier },
      sessions,
      getState,
    })
  }

  for (const status of ["completed", "error", "cancelled", "denied"] as const) {
    test(`#given a ${status} Question part #when no idle event follows #then it does not promote waiting`, async () => {
      // given
      const { notifier, notifications } = createWaitingNotifierSpy()
      const handler = createHandler(notifier)

      // when
      await handler(questionEvent({ sessionID, status }))

      // then
      expect(getWorkById(directory, workID)?.status).toBe("active")
      expect(notifications).toHaveLength(0)
    })
  }

  test("#given repeated pending Question part events #when both arrive before session.idle #then waiting metadata and notifier episode stay idempotent", async () => {
    // given
    let notifierDispatches = 0
    const notifier = createWaitingOnHumanNotifier({
      dispatchInternalPrompt: async () => {
        notifierDispatches += 1
        return { status: "dispatched", response: undefined }
      },
    })
    const handler = createHandler(notifier)

    // when
    await handler(questionEvent({ sessionID, status: "running" }))
    const initialSince = getWorkById(directory, workID)?.waiting?.since
    await handler(questionEvent({ sessionID, status: "running" }))

    // then
    expect(getWorkById(directory, workID)?.waiting?.since).toBe(initialSince)
    expect(getWorkById(directory, workID)?.waiting?.question_call_id).toBe("call-question-guard")
    expect(notifierDispatches).toBe(1)
  })

  test("#given an unbound session emits a pending Question part #when no idle event follows #then it does not change another work", async () => {
    // given
    const { notifier, notifications } = createWaitingNotifierSpy()
    const handler = createHandler(notifier)

    // when
    await handler(questionEvent({ sessionID: `ses-unbound-${randomUUID()}`, status: "in_progress" }))

    // then
    expect(getWorkById(directory, workID)?.status).toBe("active")
    expect(notifications).toHaveLength(0)
  })
})
