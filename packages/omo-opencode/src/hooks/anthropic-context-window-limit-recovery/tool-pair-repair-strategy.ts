import type { OhMyOpenCodeConfig, ExperimentalConfig } from "../../config"
import { log } from "../../shared/logger"
import type { Client } from "./client"
import { runSummarizeRetryStrategy } from "./summarize-retry-strategy"
import type { AutoCompactState, ParsedTokenLimitError } from "./types"
import { RETRY_CONFIG, TOOL_PAIR_MISMATCH } from "./types"

interface RunToolPairRepairStrategyParams {
  sessionID: string
  parsed: ParsedTokenLimitError
  autoCompactState: AutoCompactState
  client: Client
  directory: string
  pluginConfig: OhMyOpenCodeConfig
  experimental?: ExperimentalConfig
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

  log("[tool-pair-recovery] tool pair mismatch, running summarize retry", {
    sessionID: params.sessionID,
    toolUseIDs: params.parsed.toolUseIDs ?? [],
  })

  await runFallback(params)
}
