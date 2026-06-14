import { putPendingFromAsked, recordApproval, takePending } from "../shared/external-directory-approvals"

const PERMISSION_ASKED = "permission.asked"
const PERMISSION_REPLIED = "permission.replied"
const ALWAYS_REPLY = "always"
const TERMINAL_REPLIES = new Set(["always", "once", "reject"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

export function handlePermissionApprovalEvent(event: { type: string; properties?: unknown }): void {
  const props = event.properties
  if (!isRecord(props)) return

  if (event.type === PERMISSION_ASKED) {
    const metadata = props.metadata
    if (
      typeof props.sessionID !== "string" ||
      typeof props.id !== "string" ||
      typeof props.permission !== "string" ||
      !isRecord(metadata)
    ) {
      return
    }

    putPendingFromAsked({
      sessionID: props.sessionID,
      id: props.id,
      permission: props.permission,
      metadata,
    })
    return
  }

  if (event.type !== PERMISSION_REPLIED) return
  if (
    typeof props.sessionID !== "string" ||
    typeof props.requestID !== "string" ||
    typeof props.reply !== "string" ||
    !TERMINAL_REPLIES.has(props.reply)
  ) {
    return
  }

  const parentDir = takePending(props.sessionID, props.requestID)
  if (props.reply === ALWAYS_REPLY && parentDir !== undefined) {
    recordApproval(props.sessionID, parentDir)
  }
}
