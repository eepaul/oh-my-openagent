import type { PluginInput } from "@opencode-ai/plugin"

import {
  createInternalAgentContinuationTextPart,
  isAmbiguousPostDispatchPromptFailure,
  resolveInheritedPromptTools,
} from "../../shared"
import { isTokenLimitError } from "./token-limit-detection"
import { isUnrecoverableRequestError } from "./unrecoverable-request-error"
import { CONTINUATION_COOLDOWN_MS, HOOK_NAME } from "./constants"
import type { ToolPermission } from "../../features/hook-message-injector"
import { log } from "../../shared/logger"
import { dispatchInternalPrompt, isInternalPromptDispatchAccepted } from "../shared/prompt-async-gate"
import type { SessionStateStore } from "./session-state"
import type { ResolvedMessageInfo, SessionState } from "./types"
import { isBoulderSessionWaitingOnHuman } from "./waiting-on-human-plan"

export async function dispatchContinuationPrompt(input: {
  readonly ctx: PluginInput
  readonly sessionID: string
  readonly promptAgent: string | undefined
  readonly model: ResolvedMessageInfo["model"]
  readonly tools: Record<string, ToolPermission> | undefined
  readonly prompt: string
  readonly incompleteCount: number
  readonly injectionState: SessionState | undefined
  readonly sessionStateStore: SessionStateStore
  readonly isContinuationStopped?: (sessionID: string) => boolean
}): Promise<void> {
  if (input.injectionState !== undefined) {
    input.injectionState.inFlight = true
  }

  try {
    log(`[${HOOK_NAME}] Injecting continuation`, {
      sessionID: input.sessionID,
      agent: input.promptAgent,
      model: input.model,
      incompleteCount: input.incompleteCount,
    })

    const inheritedTools = resolveInheritedPromptTools(input.sessionID, input.tools)
    const launchModel = input.model === undefined
      ? undefined
      : { providerID: input.model.providerID, modelID: input.model.modelID }
    const launchVariant = input.model?.variant
    const promptResult = await dispatchInternalPrompt({
      mode: "async",
      client: input.ctx.client,
      sessionID: input.sessionID,
      source: HOOK_NAME,
      settleMs: 0,
      queueBehavior: "defer",
      semanticDedupeHoldMs: CONTINUATION_COOLDOWN_MS,
      shouldDispatch: () =>
        input.isContinuationStopped?.(input.sessionID) !== true
        && !isBoulderSessionWaitingOnHuman(input.ctx.directory, input.sessionID),
      input: {
        path: { id: input.sessionID },
        body: {
          agent: input.promptAgent,
          ...(launchModel === undefined ? {} : { model: launchModel }),
          ...(launchVariant === undefined ? {} : { variant: launchVariant }),
          ...(inheritedTools === undefined ? {} : { tools: inheritedTools }),
          parts: [createInternalAgentContinuationTextPart(input.prompt)],
        },
        query: { directory: input.ctx.directory },
      },
    })
    if (promptResult.status === "failed") {
      if (isAmbiguousPostDispatchPromptFailure(promptResult)) {
        if (input.injectionState !== undefined) {
          input.injectionState.inFlight = false
          input.injectionState.lastInjectedAt = Date.now()
          input.injectionState.awaitingPostInjectionProgressCheck = true
          input.injectionState.continuationResponseObserved = false
          input.injectionState.continuationBlockReason = undefined
          input.injectionState.pendingUserMessageID = undefined
          input.injectionState.consecutiveFailures = 0
        }
        return
      }
      throw promptResult.error
    }
    if (!isInternalPromptDispatchAccepted(promptResult)) {
      log(`[${HOOK_NAME}] Injection skipped by promptAsync gate`, { sessionID: input.sessionID, status: promptResult.status })
      if (input.injectionState !== undefined) {
        input.injectionState.inFlight = false
      }
      return
    }

    log(`[${HOOK_NAME}] Injection successful`, { sessionID: input.sessionID, status: promptResult.status })
    if (input.injectionState !== undefined) {
      input.injectionState.inFlight = false
      input.injectionState.lastInjectedAt = Date.now()
      input.injectionState.awaitingPostInjectionProgressCheck = true
      input.injectionState.continuationResponseObserved = false
      input.injectionState.continuationBlockReason = undefined
      input.injectionState.pendingUserMessageID = undefined
      input.injectionState.consecutiveFailures = 0
    }
  } catch (error) {
    log(`[${HOOK_NAME}] Injection failed`, { sessionID: input.sessionID, error: String(error) })
    if (input.injectionState !== undefined) {
      input.injectionState.inFlight = false
      input.injectionState.lastInjectedAt = Date.now()
      input.injectionState.consecutiveFailures = (input.injectionState.consecutiveFailures ?? 0) + 1

      const errorObj = error instanceof Error
        ? { name: error.name, message: error.message }
        : { message: String(error) }
      if (isTokenLimitError(errorObj)) {
        input.injectionState.tokenLimitDetected = true
        log(`[${HOOK_NAME}] Token limit error detected during injection, stopping continuation`, { sessionID: input.sessionID })
      } else if (isUnrecoverableRequestError(error)) {
        input.injectionState.unrecoverableErrorDetected = true
        log(`[${HOOK_NAME}] Non-retryable request error detected during injection, stopping continuation`, { sessionID: input.sessionID })
      }
    }
  }
}
