import { afterEach, describe, expect, test } from "bun:test"

import { releaseAllPromptAsyncReservationsForTesting } from "../../shared/prompt-async-gate"
import { createWaitingOnHumanNotifier } from "./waiting-on-human-notifier"

describe("createWaitingOnHumanNotifier gate race", () => {
  afterEach(() => {
    // then
    releaseAllPromptAsyncReservationsForTesting()
  })

  test("#given waiting clears while the gate awaits messages #when the final guard rejects #then no prompt is sent and the episode can retry", async () => {
    // given
    let promptCalls = 0
    let isWaiting = true
    const messagesRequested = Promise.withResolvers<void>()
    const messages = Promise.withResolvers<{ data: readonly unknown[] }>()
    const client = {
      session: {
        status: async () => ({ data: { ses_waiting_race: { type: "idle" } } }),
        messages: async () => {
          messagesRequested.resolve()
          return messages.promise
        },
        promptAsync: async () => {
          promptCalls += 1
        },
      },
    }
    const notifier = createWaitingOnHumanNotifier()
    const notification = {
      client,
      directory: "/workspace",
      sessionID: "ses_waiting_race",
      planPath: "/workspace/.omo/plans/plan.md",
      planName: "plan",
      blockedCount: 2,
      shouldDispatch: () => isWaiting,
      settleMs: 0,
    }

    // when
    const rejected = notifier.maybeNotify(notification)
    await messagesRequested.promise
    isWaiting = false
    messages.resolve({ data: [] })
    const rejectedResult = await rejected
    isWaiting = true
    const retriedResult = await notifier.maybeNotify(notification)

    // then
    expect(rejectedResult).toEqual({ status: "cancelled" })
    expect(retriedResult?.status).toBe("dispatched")
    expect(promptCalls).toBe(1)
  })
})
