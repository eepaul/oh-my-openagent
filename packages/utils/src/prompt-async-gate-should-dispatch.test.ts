import { afterEach, describe, expect, test } from "bun:test"

import {
  dispatchInternalPrompt,
  isInternalPromptDispatchAccepted,
  releaseAllPromptAsyncReservationsForTesting,
} from "./prompt-async-gate"

function createInput(sessionID: string) {
  return { path: { id: sessionID }, body: { parts: [] } }
}

describe("dispatchInternalPrompt shouldDispatch", () => {
  afterEach(() => {
    // then
    releaseAllPromptAsyncReservationsForTesting()
  })

  test("#given no shouldDispatch #when the gate dispatches #then its existing result and prompt side effect remain unchanged", async () => {
    // given
    let promptCalls = 0
    const client = {
      session: {
        promptAsync: async () => {
          promptCalls += 1
          return { accepted: true }
        },
      },
    }

    // when
    const result = await dispatchInternalPrompt({
      mode: "async",
      client,
      sessionID: "ses_without_guard",
      input: createInput("ses_without_guard"),
      source: "test:without-guard",
      settleMs: 0,
      postDispatchHoldMs: 0,
    })

    // then
    expect(result).toEqual({ status: "dispatched", response: { accepted: true } })
    expect(promptCalls).toBe(1)
  })

  test("#given a rejecting shouldDispatch #when the session is otherwise ready #then promptAsync is not called", async () => {
    // given
    let promptCalls = 0
    const client = {
      session: {
        promptAsync: async () => {
          promptCalls += 1
        },
      },
    }

    // when
    const result = await dispatchInternalPrompt({
      mode: "async",
      client,
      sessionID: "ses_cancelled",
      input: createInput("ses_cancelled"),
      source: "test:guard-rejected",
      settleMs: 0,
      postDispatchHoldMs: 0,
      shouldDispatch: () => false,
    })

    // then
    expect(result).toEqual({ status: "cancelled" })
    expect(isInternalPromptDispatchAccepted(result)).toBe(false)
    expect(promptCalls).toBe(0)
  })

  test("#given waiting changes while messages are awaited #when the gate reaches its final guard #then promptAsync remains blocked", async () => {
    // given
    let promptCalls = 0
    let canDispatch = true
    const messagesRead = Promise.withResolvers<void>()
    const messages = Promise.withResolvers<{ data: readonly unknown[] }>()
    const client = {
      session: {
        status: async () => ({ data: { ses_guard_race: { type: "idle" } } }),
        messages: async () => {
          messagesRead.resolve()
          return messages.promise
        },
        promptAsync: async () => {
          promptCalls += 1
        },
      },
    }

    // when
    const pendingResult = dispatchInternalPrompt({
      mode: "async",
      client,
      sessionID: "ses_guard_race",
      input: createInput("ses_guard_race"),
      source: "test:guard-race",
      settleMs: 0,
      postDispatchHoldMs: 0,
      shouldDispatch: () => canDispatch,
    })
    await messagesRead.promise
    canDispatch = false
    messages.resolve({ data: [] })
    const result = await pendingResult

    // then
    expect(result).toEqual({ status: "cancelled" })
    expect(promptCalls).toBe(0)
  })
})
