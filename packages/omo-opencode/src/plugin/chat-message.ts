import type { OhMyOpenCodeConfig } from "../config"

import { updateSessionAgent } from "../features/claude-code-session-state"
import { detectSlashCommand, extractPromptText } from "../hooks/auto-slash-command/detector"
import { compactionGraceTracker, type CompactionGraceTracker } from "../hooks/shared/compaction-grace-tracker"
import { captureHumanMessageResume, scheduleHumanMessageResume } from "../hooks/shared/human-resume-controller"
import { isResumableHumanInput } from "../hooks/shared/resumable-human-input"
import {
  isRuntimeFallbackRetryTextParts,
  isSyntheticOrInternalOnlyTextParts,
  log,
} from "../shared"
import { applyUltraworkModelOverrideOnMessage } from "./ultrawork-model-override"
import type { PluginContext } from "./types"
import { handleGoalMessage } from "./chat-message/loop-commands"
import { notifyWhenModelCacheIsMissing } from "./chat-message/model-cache-warning"
import { recordSessionModel, getStoredMainSessionModel } from "./chat-message/session-model"
import { runStartWorkHookIfApplicable } from "./chat-message/start-work-message"
import { consumeNativeGoalCommandMarker } from "./command-execute-before"
import { formatBoulderArchiveNotice, stopContinuation } from "./stop-continuation"
import type {
  ChatMessageHandlerOutput,
  ChatMessageHooks,
  ChatMessageInput,
  FirstMessageVariantGate,
} from "./chat-message/types"

export type { ChatMessageHandlerOutput, ChatMessageInput } from "./chat-message/types"

type PluginContextWithTui = {
  readonly client: {
    readonly tui: {
      readonly showToast: (input: {
        readonly body: {
          readonly title: string
          readonly message: string
          readonly variant: "warning"
          readonly duration: number
        }
      }) => Promise<unknown>
    }
  }
}

type ChatMessageResumeArgs = {
  readonly directory: string
  readonly input: ChatMessageInput
  readonly output: ChatMessageHandlerOutput
  readonly tracker: CompactionGraceTracker
}

function hasPartsOutput(value: unknown): value is { parts: Array<{ type: string; text?: string; [key: string]: unknown }> } {
  return typeof value === "object" && value !== null && "parts" in value && Array.isArray(value.parts)
}

function isRuntimeFallbackEnabled(
  hooks: ChatMessageHooks,
  pluginConfig: OhMyOpenCodeConfig,
): boolean {
  return (
    hooks.runtimeFallback !== null &&
    hooks.runtimeFallback !== undefined &&
    (typeof pluginConfig.runtime_fallback === "boolean"
      ? pluginConfig.runtime_fallback
      : (pluginConfig.runtime_fallback?.enabled ?? false))
  )
}

function resolveChatMessageID(input: ChatMessageInput, output: ChatMessageHandlerOutput): string | undefined {
  if (input.messageID !== undefined) {
    return input.messageID
  }
  const messageID = output.message["id"]
  return typeof messageID === "string" ? messageID : undefined
}

function scheduleChatMessageHumanResume(args: ChatMessageResumeArgs): void {
  const messageID = resolveChatMessageID(args.input, args.output)
  if (messageID === undefined) {
    return
  }
  const message = { role: "user", parts: args.output.parts }
  if (!isResumableHumanInput(message, {
    compactionGraceActive: args.tracker.isCompactionGraceActive(args.input.sessionID),
  })) {
    return
  }
  const snapshot = captureHumanMessageResume({
    directory: args.directory,
    sessionID: args.input.sessionID,
    messageID,
  })
  if (snapshot !== null) {
    scheduleHumanMessageResume({ tracker: args.tracker, snapshot })
  }
}

async function runChatMessageHooks(args: {
  readonly input: ChatMessageInput
  readonly output: ChatMessageHandlerOutput
  readonly hooks: ChatMessageHooks
  readonly runtimeFallbackEnabled: boolean
}): Promise<void> {
  const { input, output, hooks, runtimeFallbackEnabled } = args
  if (!runtimeFallbackEnabled) {
    await hooks.modelFallback?.["chat.message"]?.(input, output)
  }
  recordSessionModel(input, output)
  await hooks.stopContinuationGuard?.["chat.message"]?.(input)
  await hooks.backgroundNotificationHook?.["chat.message"]?.(input, output)
  await hooks.runtimeFallback?.["chat.message"]?.(input, output)
  await hooks.keywordDetector?.["chat.message"]?.(input, output)
  await hooks.thinkMode?.["chat.message"]?.(input, output)
  await hooks.claudeCodeHooks?.["chat.message"]?.(input, output)
  await hooks.autoSlashCommand?.["chat.message"]?.(input, output)
  await hooks.noSisyphusGpt?.["chat.message"]?.(input, output)
  await hooks.noHephaestusNonGpt?.["chat.message"]?.(input, output)
  await hooks.hephaestusAgentsMdInjector?.["chat.message"]?.(input, output)
}

export function createChatMessageHandler(args: {
  ctx: PluginContext
  pluginConfig: OhMyOpenCodeConfig
  firstMessageVariantGate: FirstMessageVariantGate
  hooks: ChatMessageHooks
  compactionGraceTracker?: CompactionGraceTracker
}): (
  input: ChatMessageInput,
  output: ChatMessageHandlerOutput
) => Promise<void> {
  const { ctx, pluginConfig, firstMessageVariantGate, hooks } = args
  const pluginContext = ctx as PluginContextWithTui
  const runtimeFallbackEnabled = isRuntimeFallbackEnabled(hooks, pluginConfig)
  const humanInputTracker = args.compactionGraceTracker ?? compactionGraceTracker

  return async (
    input: ChatMessageInput,
    output: ChatMessageHandlerOutput,
  ): Promise<void> => {
    const nativeGoalCommand = consumeNativeGoalCommandMarker(output.parts)
    if (isSyntheticOrInternalOnlyTextParts(output.parts)) {
      if (isRuntimeFallbackRetryTextParts(output.parts)) {
        await hooks.runtimeFallback?.["chat.message"]?.(input, output)
      }
      log("[chat-message] Skipping synthetic/internal-only message", {
        sessionID: input.sessionID,
      })
      return
    }

    if (input.agent) {
      updateSessionAgent(input.sessionID, input.agent)
    }

    const slashCommand = detectSlashCommand(extractPromptText(output.parts))
    if (slashCommand?.command === "stop-continuation") {
      const result = stopContinuation({
        directory: ctx.directory,
        hooks,
        sessionID: input.sessionID,
      })
      if (hasPartsOutput(output)) {
        output.parts.push({
          type: "text",
          text: formatBoulderArchiveNotice(result),
          synthetic: true,
        })
      }
    }

    scheduleChatMessageHumanResume({
      directory: ctx.directory,
      input,
      output,
      tracker: humanInputTracker,
    })

    const isFirstMessage = firstMessageVariantGate.shouldOverride(input.sessionID)
    if (isFirstMessage) {
      firstMessageVariantGate.markApplied(input.sessionID)
    }

    const storedMainSessionModel = getStoredMainSessionModel(
      input,
      pluginConfig,
      isFirstMessage,
    )
    if (storedMainSessionModel) {
      output.message.model = storedMainSessionModel
    }

    await runChatMessageHooks({
      input,
      output,
      hooks,
      runtimeFallbackEnabled,
    })
    await runStartWorkHookIfApplicable(hooks, input, output)
    notifyWhenModelCacheIsMissing(pluginContext.client.tui)
    handleGoalMessage({
      hooks,
      input,
      output,
      isFirstMessage,
      pluginConfig,
      nativeGoalCommand,
    })
    await applyUltraworkModelOverrideOnMessage(
      pluginConfig,
      input.agent,
      output,
      pluginContext.client.tui,
      input.sessionID,
      pluginContext.client,
    )
  }
}
