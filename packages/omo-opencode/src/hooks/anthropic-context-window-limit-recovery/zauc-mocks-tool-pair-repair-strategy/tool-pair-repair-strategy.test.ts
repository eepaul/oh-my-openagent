/// <reference types="bun-types" />
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test"
import type { OhMyOpenCodeConfig } from "../../../config"
import type { AutoCompactState, ParsedTokenLimitError, RetryState, TruncateState } from "../types"

const resolveToolOutputsMock = mock(() => Promise.resolve(new Map<string, { output: string; status: string } | null>()))
const runSummarizeRetryStrategyMock = mock(() => Promise.resolve())

mock.module("../tool-result-resolver", () => ({
  resolveToolOutputs: resolveToolOutputsMock,
}))

mock.module("../summarize-retry-strategy", () => ({
  runSummarizeRetryStrategy: runSummarizeRetryStrategyMock,
}))

mock.module("../../../shared/logger", () => ({
  log: () => {},
}))

const strategyModulePromise = import("../tool-pair-repair-strategy")

afterAll(() => {
  mock.restore()
})

function createAutoCompactState(): AutoCompactState {
  return {
    pendingCompact: new Set<string>(),
    errorDataBySession: new Map<string, ParsedTokenLimitError>(),
    retryStateBySession: new Map<string, RetryState>(),
    retryTimerBySession: new Map<string, ReturnType<typeof setTimeout>>(),
    truncateStateBySession: new Map<string, TruncateState>(),
    emptyContentAttemptBySession: new Map<string, number>(),
    toolPairRepairBySession: new Map<string, Set<string>>(),
    toolPairRepairMessagesBySession: new Map(),
    compactionInProgress: new Set<string>(),
  }
}

function createParsed(ids: string[]): ParsedTokenLimitError {
  return {
    currentTokens: 120000,
    maxTokens: 100000,
    errorType: "tool_pair_mismatch",
    messageIndex: 7,
    toolUseIDs: ids,
    providerID: "anthropic",
    modelID: "claude-sonnet-4-6",
  }
}

const client = {
  session: {
    messages: mock(() => Promise.resolve({ data: [] })),
    summarize: mock(() => Promise.resolve()),
    promptAsync: mock(() => Promise.resolve()),
  },
  tui: {
    showToast: mock(() => Promise.resolve()),
  },
}

describe("runToolPairRepairStrategy", () => {
  const sessionID = "ses-tool-pair-repair"
  const directory = "/workspace/project"
  let autoCompactState: AutoCompactState

  beforeEach(() => {
    autoCompactState = createAutoCompactState()
    resolveToolOutputsMock.mockReset()
    runSummarizeRetryStrategyMock.mockReset()
    resolveToolOutputsMock.mockResolvedValue(new Map<string, { output: string; status: string } | null>())
    runSummarizeRetryStrategyMock.mockResolvedValue(undefined)
  })

  test("#given completed output #when repairing #then it stores a synthetic tool_result and starts summarize retry", async () => {
    // given
    const { runToolPairRepairStrategy } = await strategyModulePromise
    autoCompactState.pendingCompact.add(sessionID)
    resolveToolOutputsMock.mockResolvedValue(
      new Map([["toolu_done", { output: "real completed output", status: "completed" }]]),
    )

    // when
    await runToolPairRepairStrategy({
      sessionID,
      parsed: createParsed(["toolu_done"]),
      autoCompactState,
      client: client as never,
      directory,
      pluginConfig: {} as OhMyOpenCodeConfig,
    })

    // then
    expect(resolveToolOutputsMock).toHaveBeenCalledWith(client, sessionID, directory, ["toolu_done"])
    expect(autoCompactState.toolPairRepairBySession.get(sessionID)).toEqual(new Set(["7:toolu_done"]))
    expect(autoCompactState.toolPairRepairMessagesBySession?.get(sessionID)).toEqual([
      {
        info: { role: "user", sessionID },
        parts: [
          {
            type: "tool_result",
            toolUseId: "toolu_done",
            tool_use_id: "toolu_done",
            isError: false,
            content: [{ type: "text", text: "real completed output" }],
          },
          {
            type: "text",
            text: "Recovered missing tool results. Continue from the repaired tool output.",
            synthetic: true,
          },
        ],
      },
    ])
    expect(runSummarizeRetryStrategyMock).toHaveBeenCalledWith({
      sessionID,
      msg: {
        providerID: "anthropic",
        modelID: "claude-sonnet-4-6",
      },
      autoCompactState,
      client,
      directory,
      pluginConfig: {} as OhMyOpenCodeConfig,
      errorType: "tool_pair_mismatch",
      messageIndex: 7,
    })
  })

  test("#given mixed resolved and unresolved outputs #when repairing #then summarize retry starts once", async () => {
    // given
    const { runToolPairRepairStrategy } = await strategyModulePromise
    autoCompactState.pendingCompact.add(sessionID)
    resolveToolOutputsMock.mockResolvedValue(
      new Map([
        ["toolu_done", { output: "real completed output", status: "completed" }],
        ["toolu_missing", null],
      ]),
    )

    // when
    await runToolPairRepairStrategy({
      sessionID,
      parsed: createParsed(["toolu_done", "toolu_missing"]),
      autoCompactState,
      client: client as never,
      directory,
      pluginConfig: {} as OhMyOpenCodeConfig,
    })

    // then
    expect(autoCompactState.toolPairRepairBySession.get(sessionID)).toEqual(new Set(["7:toolu_done"]))
    expect(autoCompactState.toolPairRepairMessagesBySession?.get(sessionID)).toEqual([
      {
        info: { role: "user", sessionID },
        parts: [
          {
            type: "tool_result",
            toolUseId: "toolu_done",
            tool_use_id: "toolu_done",
            isError: false,
            content: [{ type: "text", text: "real completed output" }],
          },
          {
            type: "text",
            text: "Recovered missing tool results. Continue from the repaired tool output.",
            synthetic: true,
          },
        ],
      },
    ])
    expect(runSummarizeRetryStrategyMock).toHaveBeenCalledTimes(1)
    expect(runSummarizeRetryStrategyMock).toHaveBeenCalledWith({
      sessionID,
      msg: {
        providerID: "anthropic",
        modelID: "claude-sonnet-4-6",
      },
      autoCompactState,
      client,
      directory,
      pluginConfig: {} as OhMyOpenCodeConfig,
      errorType: "tool_pair_mismatch",
      messageIndex: 7,
    })
  })

  test("#given an already repaired id #when repairing again #then it does not reinsert", async () => {
    // given
    const { runToolPairRepairStrategy } = await strategyModulePromise
    autoCompactState.toolPairRepairBySession.set(sessionID, new Set(["7:toolu_done"]))

    // when
    await runToolPairRepairStrategy({
      sessionID,
      parsed: createParsed(["toolu_done"]),
      autoCompactState,
      client: client as never,
      directory,
      pluginConfig: {} as OhMyOpenCodeConfig,
    })

    // then
    expect(resolveToolOutputsMock).not.toHaveBeenCalled()
    expect(autoCompactState.toolPairRepairMessagesBySession?.get(sessionID)).toBeUndefined()
    expect(runSummarizeRetryStrategyMock).not.toHaveBeenCalled()
  })

  test("#given resolver returns null #when repairing #then summarize retry fallback runs", async () => {
    // given
    const { runToolPairRepairStrategy } = await strategyModulePromise
    autoCompactState.pendingCompact.add(sessionID)
    resolveToolOutputsMock.mockResolvedValue(new Map([["toolu_missing", null]]))

    // when
    await runToolPairRepairStrategy({
      sessionID,
      parsed: createParsed(["toolu_missing"]),
      autoCompactState,
      client: client as never,
      directory,
      pluginConfig: {} as OhMyOpenCodeConfig,
    })

    // then
    expect(autoCompactState.toolPairRepairMessagesBySession?.get(sessionID)).toBeUndefined()
    expect(runSummarizeRetryStrategyMock).toHaveBeenCalledWith({
      sessionID,
      msg: {
        providerID: "anthropic",
        modelID: "claude-sonnet-4-6",
      },
      autoCompactState,
      client,
      directory,
      pluginConfig: {} as OhMyOpenCodeConfig,
      errorType: "tool_pair_mismatch",
      messageIndex: 7,
    })
  })
})
