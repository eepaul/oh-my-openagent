import type { BackgroundManager } from "../../features/background-agent"
import type { ToolPermission } from "../../features/hook-message-injector"
import type { WaitingOnHumanNotifier } from "../shared/waiting-on-human-notifier"

export type CountdownTimerHandle = {
  readonly cancel: () => void
  readonly unref?: () => void
}

export type CountdownScheduler = {
  readonly setTimeout: (callback: () => void, delay: number) => CountdownTimerHandle
  readonly clearTimeout: (timer: CountdownTimerHandle) => void
  readonly setInterval: (callback: () => void, delay: number) => CountdownTimerHandle
  readonly clearInterval: (timer: CountdownTimerHandle) => void
}

export interface TodoContinuationEnforcerOptions {
  backgroundManager?: BackgroundManager
  skipAgents?: string[]
  isContinuationStopped?: (sessionID: string) => boolean
  waitingOnHumanNotifier?: WaitingOnHumanNotifier
  countdownScheduler?: CountdownScheduler
}

export interface TodoContinuationEnforcer {
  handler: (input: { event: { type: string; properties?: unknown } }) => Promise<void>
  markRecovering: (sessionID: string) => void
  markRecoveryComplete: (sessionID: string) => void
  cancelAllCountdowns: () => void
  dispose: () => void
}

export interface Todo {
  content: string;
  status: string;
  priority: string;
  id?: string;
}

export interface SessionState {
  countdownTimer?: CountdownTimerHandle
  countdownInterval?: CountdownTimerHandle
  isRecovering?: boolean
  wasCancelled?: boolean
  tokenLimitDetected?: boolean
  unrecoverableErrorDetected?: boolean
  countdownStartedAt?: number
  abortDetectedAt?: number
  lastIncompleteCount?: number
  lastInjectedAt?: number
  awaitingPostInjectionProgressCheck?: boolean
  continuationResponseObserved?: boolean
  continuationBlockReason?: "directive-response" | "user-interruption"
  pendingUserMessageID?: string
  inFlight?: boolean
  stagnationCount: number
  consecutiveFailures: number
  allTodosCompletedAt?: number
  recentCompactionAt?: number
  recentCompactionEpoch?: number
  acknowledgedCompactionEpoch?: number
}

export interface MessageInfo {
  id?: string
  role?: string
  error?: { name?: string; data?: unknown }
  agent?: string
  model?: { providerID: string; modelID: string; variant?: string }
  providerID?: string
  modelID?: string
  tools?: Record<string, ToolPermission>
}

export interface MessageWithInfo {
  info?: MessageInfo
  parts?: Array<{ type?: string; text?: string; synthetic?: boolean }>
}

export interface ResolvedMessageInfo {
  agent?: string
  model?: { providerID: string; modelID: string; variant?: string }
  tools?: Record<string, ToolPermission>
}

export interface ResolveLatestMessageInfoResult {
  resolvedInfo?: ResolvedMessageInfo
  encounteredCompaction: boolean
  latestMessageWasCompaction: boolean
}
