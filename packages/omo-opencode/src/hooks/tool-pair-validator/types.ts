import type { Message, Part } from "@opencode-ai/sdk"

export type ToolUsePart = {
  type: "tool_use"
  id: string
  [key: string]: unknown
}

export type ToolResultPart = {
  type: "tool_result"
  toolUseId: string
  tool_use_id?: string
  isError?: boolean
  content: Array<{ type: "text"; text: string }>
  [key: string]: unknown
}

export type SyntheticTextPart = {
  type: "text"
  text: string
  synthetic: true
}

// Wider than the SDK `Part` on purpose: the tool_pair_mismatch recovery strategy
// injects synthetic tool_result/text parts into the transform stream, and those
// shapes never originate from an OpenCode message.
export type TransformPart = Part | ToolUsePart | ToolResultPart | SyntheticTextPart

export type TransformMessageInfo = Message | {
  role: "user"
  sessionID?: string
}

export interface MessageWithParts {
  info: TransformMessageInfo
  parts: TransformPart[]
}

export type UnpairedToolPart = {
  readonly callID: string
  readonly status: string
}

export type MessagesTransformHook = {
  "experimental.chat.messages.transform"?: (
    input: Record<string, never>,
    output: { messages: MessageWithParts[] }
  ) => Promise<void>
}
