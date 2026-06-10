import { isSyntheticOrInternalUserMessage, log } from "../../shared"
import {
  latestAssistantTurnBlocksInternalPrompt,
  latestAssistantTurnHasUnansweredQuestion,
} from "../../shared/prompt-async-gate/pending-tool-turn"
import {
  latestAssistantTurnHasFreshToolActivity,
  latestAssistantTurnHasToolBlock,
  latestAssistantTurnIsCompletedEmptyNoProgress,
} from "./parent-wake-history-state"
import type { PendingParentWake } from "./parent-wake-dedupe"
import { getParentWakeMessageCreatedAt } from "./parent-wake-message-activity"

export type ParentWakeSessionMessage = {
  readonly info?: {
    readonly role?: string
    readonly finish?: string
    readonly error?: unknown
    readonly time?: {
      readonly created?: unknown
      readonly updated?: unknown
      readonly completed?: unknown
      readonly start?: unknown
      readonly end?: unknown
    }
  }
  readonly role?: string
  readonly finish?: string
  readonly error?: unknown
  readonly time?: {
    readonly created?: unknown
    readonly updated?: unknown
    readonly completed?: unknown
    readonly start?: unknown
    readonly end?: unknown
  }
  readonly parts?: readonly {
    readonly type?: string
    readonly text?: string
    readonly synthetic?: boolean
    readonly content?: unknown
    readonly time?: {
      readonly created?: unknown
      readonly updated?: unknown
      readonly completed?: unknown
      readonly start?: unknown
      readonly end?: unknown
    }
    readonly state?: {
      readonly status?: unknown
      readonly time?: {
        readonly created?: unknown
        readonly updated?: unknown
        readonly completed?: unknown
        readonly start?: unknown
        readonly end?: unknown
      }
    }
  }[]
}

export type ToolWaitDeferralDecision = {
  readonly defer: boolean
  readonly skipPromptGateToolStateCheck: boolean
  readonly inspectedMessageCount?: number
}

export function parentWakeUserMessageIsInProgress(input: {
  readonly messages: readonly ParentWakeSessionMessage[] | undefined
  readonly windowMs: number
  readonly now?: number
}): boolean {
  if (input.windowMs <= 0) {
    return false
  }
  if (!input.messages) {
    return true
  }
  const now = input.now ?? Date.now()
  for (let index = input.messages.length - 1; index >= 0; index--) {
    const message = input.messages[index]
    if (!message) {
      continue
    }
    const role = getParentWakeMessageRole(message)
    if (role === "user") {
      if (isSyntheticOrInternalUserMessage(message)) {
        continue
      }
      const createdAt = getParentWakeMessageCreatedAt(message)
      if (createdAt === undefined) {
        return false
      }
      return now - createdAt <= input.windowMs
    }
    if (role === "assistant" || role === "tool") {
      return false
    }
  }
  return false
}

export function getParentWakeSessionHistoryDeferralDecision(input: {
  readonly sessionID: string
  readonly messages: readonly ParentWakeSessionMessage[] | undefined
  readonly wake: PendingParentWake
  readonly toolCallDeferMaxMs: number
  readonly now?: number
}): ToolWaitDeferralDecision {
  if (!input.messages) {
    log("[background-agent] Deferred parent wake because parent messages could not be inspected:", {
      sessionID: input.sessionID,
    })
    return { defer: true, skipPromptGateToolStateCheck: false, inspectedMessageCount: undefined }
  }
  const messages = withoutTrailingBackgroundWakeInternalUserMessages(input.messages)
  const skippedTrailingBackgroundWake = messages.length !== input.messages.length
  const latestAssistantBlocksPrompt = latestAssistantTurnBlocksInternalPrompt(messages)
  const latestAssistantHasUnansweredQuestion = latestAssistantTurnHasUnansweredQuestion(messages)
  if (!latestAssistantBlocksPrompt) {
    delete input.wake.toolCallDeferralStartedAt
    delete input.wake.allowEmptyAssistantTurnRetry
    return {
      defer: false,
      skipPromptGateToolStateCheck: skippedTrailingBackgroundWake,
      inspectedMessageCount: input.messages.length,
    }
  }
  const now = input.now ?? Date.now()
  input.wake.toolCallDeferralStartedAt ??= now
  if (input.wake.allowEmptyAssistantTurnRetry && latestAssistantTurnIsCompletedEmptyNoProgress(messages)) {
    log("[background-agent] Retrying parent wake after completed empty assistant turn:", { sessionID: input.sessionID })
    return { defer: false, skipPromptGateToolStateCheck: true, inspectedMessageCount: input.messages.length }
  }
  if (latestAssistantHasUnansweredQuestion) {
    log("[background-agent] Deferred parent wake because latest assistant question awaits user response:", {
      sessionID: input.sessionID,
    })
    return { defer: true, skipPromptGateToolStateCheck: false, inspectedMessageCount: input.messages.length }
  }
  if (
    now - input.wake.toolCallDeferralStartedAt >= input.toolCallDeferMaxMs
    && latestAssistantTurnHasToolBlock(messages)
    && !latestAssistantTurnHasFreshToolActivity(messages, now, input.toolCallDeferMaxMs)
  ) {
    delete input.wake.toolCallDeferralStartedAt
    log("[background-agent] Retrying parent wake after stale tool-call deferral:", { sessionID: input.sessionID })
    return { defer: false, skipPromptGateToolStateCheck: true, inspectedMessageCount: input.messages.length }
  }
  log("[background-agent] Deferred parent wake because latest assistant turn blocks internal prompts:", {
    sessionID: input.sessionID,
  })
  return { defer: true, skipPromptGateToolStateCheck: false, inspectedMessageCount: input.messages.length }
}

export function hasRecordedParentWakePromptMessage(input: {
  readonly messages: readonly ParentWakeSessionMessage[] | undefined
  readonly wake: PendingParentWake
  readonly acceptedMessageSkewMs: number
}): boolean {
  if (input.wake.dispatchedAt === undefined || !input.messages) {
    return false
  }
  const dispatchedAt = input.wake.dispatchedAt
  return input.messages.some((message) => {
    const createdAt = getParentWakeMessageCreatedAt(message)
    if (createdAt === undefined) {
      return false
    }
    if (
      createdAt >= dispatchedAt - input.acceptedMessageSkewMs
      && parentWakeMessageContainsNotification(message, input.wake)
    ) {
      return true
    }
    return createdAt >= dispatchedAt && parentWakeMessageHasOutput(message)
  })
}

export function hasAssistantOrToolOutputAfterParentWake(input: {
  readonly messages: readonly ParentWakeSessionMessage[] | undefined
  readonly wake: PendingParentWake
}): boolean {
  if (input.wake.dispatchedAt === undefined || !input.messages) {
    return false
  }
  const dispatchedAt = input.wake.dispatchedAt
  return input.messages.some((message) => {
    const createdAt = getParentWakeMessageCreatedAt(message)
    return createdAt !== undefined
      && createdAt >= dispatchedAt
      && parentWakeMessageHasOutput(message)
  })
}

function getParentWakeMessageRole(message: ParentWakeSessionMessage): string | undefined {
  return message.info?.role ?? message.role
}

function messageTextIncludesBackgroundWakeHeader(message: ParentWakeSessionMessage): boolean {
  return message.parts?.some((part) => {
    if (typeof part.text !== "string") {
      return false
    }
    return part.text.includes("[BACKGROUND TASK RESULT READY]")
      || part.text.includes("[BACKGROUND TASK RETRY SESSION READY]")
      || part.text.includes("[BACKGROUND TASK COMPLETED]")
      || part.text.includes("[ALL BACKGROUND TASKS COMPLETE]")
  }) ?? false
}

function backgroundWakeInternalUserMessageIsTransparent(message: ParentWakeSessionMessage): boolean {
  return isSyntheticOrInternalUserMessage(message) && messageTextIncludesBackgroundWakeHeader(message)
}

function withoutTrailingBackgroundWakeInternalUserMessages(
  messages: readonly ParentWakeSessionMessage[],
): ParentWakeSessionMessage[] {
  const trimmed = [...messages]
  while (trimmed.length > 0) {
    const latest = trimmed[trimmed.length - 1]
    if (!latest || !backgroundWakeInternalUserMessageIsTransparent(latest)) {
      break
    }
    trimmed.pop()
  }
  return trimmed
}

function parentWakeMessageHasOutput(message: ParentWakeSessionMessage): boolean {
  const role = getParentWakeMessageRole(message)
  if (role !== "assistant" && role !== "tool") {
    return false
  }
  const finish = message.info?.finish ?? message.finish
  const error = message.info?.error ?? message.error
  if (role === "assistant" && (finish === "error" || error !== undefined)) {
    return false
  }
  if (!message.parts || message.parts.length === 0) {
    return role === "assistant"
  }
  return message.parts.some((part) => {
    if (part.type === "text" || part.type === "reasoning") {
      return typeof part.text === "string" && part.text.trim().length > 0
    }
    if (
      part.type === "tool"
      || part.type === "tool_use"
      || part.type === "tool-call"
      || part.type === "tool-invocation"
      || part.type === "tool_result"
      || part.type === "tool-result"
    ) {
      return true
    }
    if (part.content !== undefined) {
      if (typeof part.content === "string") {
        return part.content.trim().length > 0
      }
      if (Array.isArray(part.content)) {
        return part.content.length > 0
      }
      return true
    }
    return false
  })
}

function parentWakeMessageContainsNotification(message: ParentWakeSessionMessage, wake: PendingParentWake): boolean {
  if (getParentWakeMessageRole(message) !== "user") {
    return false
  }
  return message.parts?.some((part) =>
    typeof part.text === "string" && wake.notifications.some((notification) => part.text?.includes(notification))
  ) ?? false
}
