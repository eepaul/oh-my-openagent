export const QUESTION_TOOL_NAMES = new Set([
  "question",
  "ask_user_question",
  "askuserquestion",
])

const PENDING_QUESTION_TOOL_STATUSES = new Set([
  "pending",
  "running",
  "in_progress",
])

const TERMINAL_QUESTION_TOOL_STATUSES = new Set([
  "completed",
  "error",
  "cancelled",
  "denied",
])

export type QuestionToolStatusDisposition = "pending" | "terminal" | "unknown"

export function questionToolStatusDisposition(status: unknown): QuestionToolStatusDisposition {
  if (status === undefined || (typeof status === "string" && PENDING_QUESTION_TOOL_STATUSES.has(status))) {
    return "pending"
  }
  if (typeof status === "string" && TERMINAL_QUESTION_TOOL_STATUSES.has(status)) {
    return "terminal"
  }
  return "unknown"
}
