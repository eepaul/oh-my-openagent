import type { PluginInput } from "@opencode-ai/plugin"
import { normalizeSDKResponse } from "../../shared"
import { log } from "../../shared/logger"

type OpencodeClient = PluginInput["client"]

const MAX_OUTPUT_CHARS = 20000

export interface ResolvedToolOutput {
  output: string
  status: string
}

interface SDKToolState {
  status?: unknown
  output?: unknown
}

interface SDKToolPart {
  type?: unknown
  callID?: unknown
  state?: SDKToolState
}

interface SDKMessage {
  parts?: unknown
}

function truncate(value: string): string {
  return value.length > MAX_OUTPUT_CHARS ? value.slice(0, MAX_OUTPUT_CHARS) : value
}

function coerceOutput(rawOutput: unknown): string | null {
  if (typeof rawOutput === "string") {
    return truncate(rawOutput)
  }
  if (rawOutput == null) {
    return null
  }
  try {
    const serialized = JSON.stringify(rawOutput)
    if (typeof serialized !== "string" || serialized.length === 0) {
      return null
    }
    return truncate(serialized)
  } catch {
    return null
  }
}

function resolvePart(part: SDKToolPart): ResolvedToolOutput | null {
  const state = part.state
  const status = typeof state?.status === "string" ? state.status : "unknown"
  if (status !== "completed") {
    return null
  }
  const output = coerceOutput(state?.output)
  if (output == null) {
    return null
  }
  return { output, status }
}

async function fetchMessages(
  client: OpencodeClient,
  sessionID: string,
  directory: string,
): Promise<SDKMessage[]> {
  try {
    const response = await client.session.messages({
      path: { id: sessionID },
      query: { directory },
    })
    const normalized = normalizeSDKResponse(response, [] as SDKMessage[], {
      preferResponseOnMissingData: true,
    })
    return Array.isArray(normalized) ? normalized : []
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error
    }
    log("[tool-pair-recovery] resolveToolOutputs failed to read session messages", {
      sessionID,
      error: error.message,
    })
    return []
  }
}

/**
 * Resolve each orphan `tool_use_id` to its real `state.output` recorded in the
 * session's stored `tool` parts. Read-only: never mutates stored messages.
 *
 * Map semantics:
 * - completed part with usable output -> { output, status }
 * - found part that is error/pending or has no usable output -> null
 * - id never matched, or the SDK read failed -> absent from the Map
 */
export async function resolveToolOutputs(
  client: OpencodeClient,
  sessionID: string,
  directory: string,
  toolUseIDs: string[],
): Promise<Map<string, ResolvedToolOutput | null>> {
  const results = new Map<string, ResolvedToolOutput | null>()
  if (toolUseIDs.length === 0) {
    return results
  }

  const wanted = new Set(toolUseIDs)
  const messages = await fetchMessages(client, sessionID, directory)

  for (const message of messages) {
    const parts = message?.parts
    if (!Array.isArray(parts)) {
      continue
    }

    for (const rawPart of parts) {
      if (typeof rawPart !== "object" || rawPart === null) {
        continue
      }
      const part = rawPart as SDKToolPart
      if (part.type !== "tool" || typeof part.callID !== "string") {
        continue
      }
      const callID = part.callID
      if (!wanted.has(callID)) {
        continue
      }
      if (results.get(callID) != null) {
        continue
      }

      try {
        results.set(callID, resolvePart(part))
      } catch (error) {
        if (!(error instanceof Error)) {
          throw error
        }
        results.set(callID, null)
      }
    }
  }

  return results
}
