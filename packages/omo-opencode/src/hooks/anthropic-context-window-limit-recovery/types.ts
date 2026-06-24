export interface ParsedTokenLimitError {
  currentTokens: number
  maxTokens: number
  requestId?: string
  errorType: string
  providerID?: string
  modelID?: string
  messageIndex?: number
  toolUseIDs?: string[]
}

export const TOOL_PAIR_MISMATCH = "tool_pair_mismatch" as const

export interface RetryState {
  attempt: number
  lastAttemptTime: number
  firstAttemptTime: number
}

export interface TruncateState {
  truncateAttempt: number
  lastTruncatedPartId?: string
}

export interface ToolPairRepairTextContent {
  type: "text"
  text: string
}

export interface ToolPairRepairToolResultPart {
  type: "tool_result"
  toolUseId: string
  tool_use_id: string
  isError: false
  content: ToolPairRepairTextContent[]
}

export interface ToolPairRepairContinuationPart {
  type: "text"
  text: string
  synthetic: true
}

export interface ToolPairRepairSyntheticMessage {
  info: {
    role: "user"
    sessionID: string
  }
  parts: Array<ToolPairRepairToolResultPart | ToolPairRepairContinuationPart>
}

export interface AutoCompactState {
  pendingCompact: Set<string>
  errorDataBySession: Map<string, ParsedTokenLimitError>
  retryStateBySession: Map<string, RetryState>
  retryTimerBySession: Map<string, ReturnType<typeof setTimeout>>
  truncateStateBySession: Map<string, TruncateState>
  emptyContentAttemptBySession: Map<string, number>
  toolPairRepairBySession: Map<string, Set<string>>
  toolPairRepairMessagesBySession?: Map<string, ToolPairRepairSyntheticMessage[]>
  compactionInProgress: Set<string>
}

export const RETRY_CONFIG = {
  maxAttempts: 2,
  initialDelayMs: 2000,
  backoffFactor: 2,
  maxDelayMs: 30000,
} as const

export const TRUNCATE_CONFIG = {
  maxTruncateAttempts: 20,
  minOutputSizeToTruncate: 500,
  targetTokenRatio: 0.5,
  charsPerToken: 4,
} as const
