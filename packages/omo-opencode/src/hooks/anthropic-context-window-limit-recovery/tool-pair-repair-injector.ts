import type { AutoCompactState, ToolPairRepairSyntheticMessage } from "./types"
import type { MessageWithParts, MessagesTransformHook, TransformPart } from "../tool-pair-validator/types"
import { findUnpairedToolParts, isRecord, toRecord } from "../tool-pair-validator/tool-part-ids"

function getAssistantToolUseIDs(parts: TransformPart[]): Set<string> {
  const toolUseIDs = new Set(findUnpairedToolParts(parts).map((part) => part.callID))
  for (const part of parts) {
    const record = toRecord(part)
    if (record?.["type"] !== "tool_use") {
      continue
    }
    const id = record["id"]
    if (typeof id === "string" && id.length > 0) {
      toolUseIDs.add(id)
    }
  }
  return toolUseIDs
}

function getMessageRole(message: MessageWithParts): string | undefined {
  const info: unknown = message.info
  return isRecord(info) && typeof info.role === "string" ? info.role : undefined
}

function getMessageSessionID(message: MessageWithParts): string | undefined {
  const info: unknown = message.info
  if (isRecord(info) && typeof info.sessionID === "string" && info.sessionID.length > 0) {
    return info.sessionID
  }
  return undefined
}

function resolveSessionID(messages: MessageWithParts[]): string | undefined {
  for (const message of messages) {
    const sessionID = getMessageSessionID(message)
    if (sessionID) {
      return sessionID
    }
  }
  return undefined
}

function getSyntheticToolUseIDs(message: ToolPairRepairSyntheticMessage): string[] {
  const ids: string[] = []
  for (const part of message.parts) {
    if (part.type === "tool_result") {
      ids.push(part.toolUseId)
    }
  }
  return ids
}

function toMessageWithParts(synthetic: ToolPairRepairSyntheticMessage): MessageWithParts {
  const parts = synthetic.parts.map((part): TransformPart => {
    if (part.type === "tool_result") {
      return {
        type: "tool_result",
        toolUseId: part.toolUseId,
        tool_use_id: part.tool_use_id,
        isError: part.isError,
        content: part.content,
      }
    }
    return { type: "text", text: part.text, synthetic: true }
  })
  return { info: synthetic.info, parts }
}

function injectSyntheticMessages(
  messages: MessageWithParts[],
  pending: ToolPairRepairSyntheticMessage[],
): void {
  const consumed = new Set<number>()
  const result: MessageWithParts[] = []

  for (const message of messages) {
    result.push(message)
    if (getMessageRole(message) !== "assistant") {
      continue
    }

    const toolUseIDs = getAssistantToolUseIDs(message.parts)
    pending.forEach((synthetic, index) => {
      if (consumed.has(index)) {
        return
      }
      if (getSyntheticToolUseIDs(synthetic).some((id) => toolUseIDs.has(id))) {
        result.push(toMessageWithParts(synthetic))
        consumed.add(index)
      }
    })
  }

  pending.forEach((synthetic, index) => {
    if (!consumed.has(index)) {
      result.push(toMessageWithParts(synthetic))
    }
  })

  messages.splice(0, messages.length, ...result)
}

export function createToolPairRepairInjectorHook(
  getAutoCompactState: () => AutoCompactState | undefined,
): MessagesTransformHook {
  return {
    "experimental.chat.messages.transform": async (_input, output) => {
      const store = getAutoCompactState()?.toolPairRepairMessagesBySession
      if (!store) {
        return
      }

      const sessionID = resolveSessionID(output.messages)
      if (!sessionID) {
        return
      }

      const pending = store.get(sessionID)
      if (!pending || pending.length === 0) {
        return
      }

      injectSyntheticMessages(output.messages, pending)
      store.delete(sessionID)
    },
  }
}
