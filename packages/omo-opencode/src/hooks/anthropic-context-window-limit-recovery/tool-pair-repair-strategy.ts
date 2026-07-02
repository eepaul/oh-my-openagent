import type { OhMyOpenCodeConfig, ExperimentalConfig } from "../../config"
import { log } from "../../shared/logger"
import type { Client } from "./client"
import { runSummarizeRetryStrategy } from "./summarize-retry-strategy"
import { resolveToolOutputs } from "./tool-result-resolver"
import type {
  AutoCompactState,
  ParsedTokenLimitError,
  ToolPairRepairSyntheticMessage,
  ToolPairRepairToolResultPart,
} from "./types"
import { RETRY_CONFIG, TOOL_PAIR_MISMATCH } from "./types"

const TOOL_RESULT_RECOVERY_CONTINUATION = "Recovered missing tool results. Continue from the repaired tool output."

interface RunToolPairRepairStrategyParams {
  sessionID: string
  parsed: ParsedTokenLimitError
  autoCompactState: AutoCompactState
  client: Client
  directory: string
  pluginConfig: OhMyOpenCodeConfig
  experimental?: ExperimentalConfig
}

function getMessageIndex(parsed: ParsedTokenLimitError): number {
  return parsed.messageIndex ?? -1
}

function createIdempotencyKey(messageIndex: number, toolUseID: string): string {
  return `${messageIndex}:${toolUseID}`
}

function getOrCreateRepairSet(autoCompactState: AutoCompactState, sessionID: string): Set<string> {
  let repaired = autoCompactState.toolPairRepairBySession.get(sessionID)
  if (repaired === undefined) {
    repaired = new Set<string>()
    autoCompactState.toolPairRepairBySession.set(sessionID, repaired)
  }
  return repaired
}

function getOrCreateMessageStore(
  autoCompactState: AutoCompactState,
): Map<string, ToolPairRepairSyntheticMessage[]> {
  if (autoCompactState.toolPairRepairMessagesBySession === undefined) {
    autoCompactState.toolPairRepairMessagesBySession = new Map<string, ToolPairRepairSyntheticMessage[]>()
  }
  return autoCompactState.toolPairRepairMessagesBySession
}

function createToolResultPart(toolUseID: string, output: string): ToolPairRepairToolResultPart {
  return {
    type: "tool_result",
    toolUseId: toolUseID,
    tool_use_id: toolUseID,
    isError: false,
    content: [{ type: "text", text: output }],
  }
}

function createSyntheticUserMessage(
  sessionID: string,
  parts: ToolPairRepairToolResultPart[],
): ToolPairRepairSyntheticMessage {
  return {
    info: { role: "user", sessionID },
    parts: [
      ...parts,
      {
        type: "text",
        text: TOOL_RESULT_RECOVERY_CONTINUATION,
        synthetic: true,
      },
    ],
  }
}

function appendSyntheticMessage(
  autoCompactState: AutoCompactState,
  sessionID: string,
  message: ToolPairRepairSyntheticMessage,
): void {
  const store = getOrCreateMessageStore(autoCompactState)
  const existingMessages = store.get(sessionID) ?? []
  store.set(sessionID, [...existingMessages, message])
}

function shouldRunSummarizeFallback(autoCompactState: AutoCompactState, sessionID: string): boolean {
  const retryState = autoCompactState.retryStateBySession.get(sessionID)
  return (retryState?.attempt ?? 0) < RETRY_CONFIG.maxAttempts
}

async function runFallback(params: RunToolPairRepairStrategyParams): Promise<void> {
  if (!shouldRunSummarizeFallback(params.autoCompactState, params.sessionID)) {
    log("[tool-pair-recovery] summarize fallback skipped after max attempts", {
      sessionID: params.sessionID,
      maxAttempts: RETRY_CONFIG.maxAttempts,
    })
    return
  }

  await runSummarizeRetryStrategy({
    sessionID: params.sessionID,
    msg: {
      providerID: params.parsed.providerID,
      modelID: params.parsed.modelID,
    },
    autoCompactState: params.autoCompactState,
    client: params.client,
    directory: params.directory,
    pluginConfig: params.pluginConfig,
    errorType: params.parsed.errorType,
    messageIndex: params.parsed.messageIndex,
  })
}

export async function runToolPairRepairStrategy(params: RunToolPairRepairStrategyParams): Promise<void> {
  if (params.parsed.errorType !== TOOL_PAIR_MISMATCH) {
    return
  }

  const toolUseIDs = params.parsed.toolUseIDs ?? []
  if (toolUseIDs.length === 0) {
    await runFallback(params)
    return
  }

  const messageIndex = getMessageIndex(params.parsed)
  const repaired = getOrCreateRepairSet(params.autoCompactState, params.sessionID)
  const pendingToolUseIDs = toolUseIDs.filter(
    (toolUseID) => !repaired.has(createIdempotencyKey(messageIndex, toolUseID)),
  )

  if (pendingToolUseIDs.length === 0) {
    return
  }

  let resolvedOutputs: Map<string, { output: string; status: string } | null>
  try {
    resolvedOutputs = await resolveToolOutputs(
      params.client,
      params.sessionID,
      params.directory,
      pendingToolUseIDs,
    )
  } catch (error) {
    log("[tool-pair-recovery] resolveToolOutputs threw during repair", {
      sessionID: params.sessionID,
      error: error instanceof Error ? error.message : String(error),
    })
    await runFallback(params)
    return
  }

  const resolvedParts: ToolPairRepairToolResultPart[] = []
  const resolvedIDs: string[] = []
  const unresolvedIDs: string[] = []

  for (const toolUseID of pendingToolUseIDs) {
    const resolved = resolvedOutputs.get(toolUseID)
    if (resolved === undefined || resolved === null) {
      unresolvedIDs.push(toolUseID)
      continue
    }

    resolvedParts.push(createToolResultPart(toolUseID, resolved.output))
    resolvedIDs.push(toolUseID)
  }

  const hasResolvedParts = resolvedParts.length > 0

  if (hasResolvedParts) {
    appendSyntheticMessage(
      params.autoCompactState,
      params.sessionID,
      createSyntheticUserMessage(params.sessionID, resolvedParts),
    )

    for (const toolUseID of resolvedIDs) {
      repaired.add(createIdempotencyKey(messageIndex, toolUseID))
    }

    await runFallback(params)
  }

  if (unresolvedIDs.length > 0) {
    log("[tool-pair-recovery] falling back to summarize retry for unresolved tool results", {
      sessionID: params.sessionID,
      unresolvedIDs,
    })
  }

  if (!hasResolvedParts) {
    await runFallback(params)
  }
}
