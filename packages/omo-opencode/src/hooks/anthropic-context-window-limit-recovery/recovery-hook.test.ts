import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import {
  createRecoveryHook,
  executeCompactMock,
  getLastAssistantMock,
  parseAnthropicTokenLimitErrorMock,
  parseToolPairMismatchErrorMock,
  runToolPairRepairStrategyMock,
  setupDelayedTimeoutMocks,
} from "./recovery-hook.test-support"

describe("createAnthropicContextWindowLimitRecoveryHook", () => {
  beforeEach(() => {
    executeCompactMock.mockClear()
    getLastAssistantMock.mockClear()
    parseAnthropicTokenLimitErrorMock.mockClear()
    parseToolPairMismatchErrorMock.mockClear()
    runToolPairRepairStrategyMock.mockClear()
  })

  afterEach(() => {
    mock.restore()
  })

  test("cancels pending timer when session.idle handles compaction first", async () => {
    //#given
    const { restore, getClearTimeoutCalls, getScheduledTimeouts } = setupDelayedTimeoutMocks()
    let compactedSessionID: unknown
    executeCompactMock.mockImplementationOnce(async (...args: unknown[]) => {
      compactedSessionID = args[0]
    })
    const hook = createRecoveryHook()

    try {
      //#when
      await hook.event({
        event: {
          type: "session.error",
          properties: { sessionID: "session-race", error: "prompt is too long" },
        },
      })

      await hook.event({
        event: {
          type: "session.idle",
          properties: { sessionID: "session-race" },
        },
      })

      //#then
      expect(getClearTimeoutCalls()).toEqual([getScheduledTimeouts()[0]])
      expect(executeCompactMock).toHaveBeenCalledTimes(1)
      expect(compactedSessionID).toBe("session-race")
    } finally {
      restore()
    }
  })

  test("clears pending recovery when OpenCode core compaction succeeds first", async () => {
    //#given
    const { restore, getClearTimeoutCalls, getScheduledTimeouts } = setupDelayedTimeoutMocks()
    const hook = createRecoveryHook()

    try {
      await hook.event({
        event: {
          type: "session.error",
          properties: { sessionID: "session-core-compacted", error: "prompt is too long" },
        },
      })

      //#when
      await hook.event({
        event: {
          type: "session.compacted",
          properties: { sessionID: "session-core-compacted" },
        },
      })

      await hook.event({
        event: {
          type: "session.idle",
          properties: { sessionID: "session-core-compacted" },
        },
      })

      //#then
      expect(getClearTimeoutCalls()).toEqual([getScheduledTimeouts()[0]])
      expect(executeCompactMock).not.toHaveBeenCalled()
      expect(getLastAssistantMock).toHaveBeenCalledTimes(1)
    } finally {
      restore()
    }
  })

  test("does not treat empty summary assistant messages as successful compaction", async () => {
    //#given
    const { restore, getClearTimeoutCalls, getScheduledTimeouts } = setupDelayedTimeoutMocks()
    let compactedSessionID: unknown
    executeCompactMock.mockImplementationOnce(async (...args: unknown[]) => {
      compactedSessionID = args[0]
    })
    getLastAssistantMock.mockResolvedValueOnce({
      info: {
        summary: true,
        providerID: "anthropic",
        modelID: "claude-sonnet-4-6",
      },
      hasContent: false,
    })
    const hook = createRecoveryHook()

    try {
      //#when
      await hook.event({
        event: {
          type: "session.error",
          properties: { sessionID: "session-empty-summary", error: "prompt is too long" },
        },
      })

      await hook.event({
        event: {
          type: "session.idle",
          properties: { sessionID: "session-empty-summary" },
        },
      })

      //#then
      expect(getClearTimeoutCalls()).toEqual([getScheduledTimeouts()[0]])
      expect(executeCompactMock).toHaveBeenCalledTimes(1)
      expect(compactedSessionID).toBe("session-empty-summary")
    } finally {
      restore()
    }
  })

  test("#given active pending and retry timers #when dispose is called #then it clears both timer maps", async () => {
    //#given
    const { createUntrackedTimeout, getClearTimeoutCalls, getScheduledTimeouts, restore, runScheduledTimeout } =
      setupDelayedTimeoutMocks()
    executeCompactMock.mockImplementationOnce(async (...args: Parameters<typeof executeCompactMock>) => {
      const sessionID = args[0]
      const autoCompactState = args[2]

      autoCompactState.retryTimerBySession.set(sessionID, createUntrackedTimeout())
    })
    const hook = createRecoveryHook()

    try {
      await hook.event({
        event: {
          type: "session.error",
          properties: { sessionID: "session-retry", error: "prompt is too long" },
        },
      })

      await hook.event({
        event: {
          type: "session.error",
          properties: { sessionID: "session-pending", error: "prompt is too long" },
        },
      })

      runScheduledTimeout(0)

      const [retryTimer, pendingTimer] = getScheduledTimeouts()

      //#when
      hook.dispose()

      //#then
      expect(getClearTimeoutCalls()).toEqual(expect.arrayContaining([retryTimer, pendingTimer]))
    } finally {
      restore()
    }
  })

  test("#given session.error with tool_pair_mismatch #when handled #then runs repair strategy before token-limit path and skips compact", async () => {
    //#given
    parseToolPairMismatchErrorMock.mockReturnValueOnce({
      currentTokens: 0,
      maxTokens: 0,
      errorType: "tool_pair_mismatch",
      messageIndex: 3,
      toolUseIDs: ["toolu_abc"],
    })
    const hook = createRecoveryHook()

    //#when
    await hook.event({
      event: {
        type: "session.error",
        properties: {
          sessionID: "session-tool-pair",
          error: { error: { message: "tool_use ids were found without tool_result blocks immediately after" } },
        },
      },
    })

    //#then
    expect(runToolPairRepairStrategyMock).toHaveBeenCalledTimes(1)
    const repairArgs = runToolPairRepairStrategyMock.mock.calls[0]?.[0]
    expect(repairArgs?.sessionID).toBe("session-tool-pair")
    expect(repairArgs?.parsed.errorType).toBe("tool_pair_mismatch")
    expect(parseAnthropicTokenLimitErrorMock).not.toHaveBeenCalled()
    expect(executeCompactMock).not.toHaveBeenCalled()
  })

  test("#given session.error with token-limit error #when handled #then keeps existing compact path and skips tool-pair repair", async () => {
    //#given
    const { restore } = setupDelayedTimeoutMocks()
    const hook = createRecoveryHook()

    try {
      //#when
      await hook.event({
        event: {
          type: "session.error",
          properties: { sessionID: "session-token-regression", error: "prompt is too long" },
        },
      })

      await hook.event({
        event: {
          type: "session.idle",
          properties: { sessionID: "session-token-regression" },
        },
      })

      //#then
      expect(runToolPairRepairStrategyMock).not.toHaveBeenCalled()
      expect(parseAnthropicTokenLimitErrorMock).toHaveBeenCalled()
      expect(executeCompactMock).toHaveBeenCalledTimes(1)
    } finally {
      restore()
    }
  })

})
