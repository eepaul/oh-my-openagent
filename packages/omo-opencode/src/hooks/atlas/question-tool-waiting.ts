import type { PluginInput } from "@opencode-ai/plugin"
import { enterWaitingOnHuman, resumeFromHuman } from "@oh-my-opencode/boulder-state"
import {
  isRecord,
  latestAssistantTurnPendingQuestionTool,
  type PendingQuestionTool,
} from "@oh-my-opencode/utils"
import { log } from "../../shared/logger"
import {
  currentResumeEpoch,
  isFailClosed,
  recordHumanResumeAndClearIfMatch,
  runPromotion,
} from "../shared/waiting-fail-closed-gate"
import { HOOK_NAME } from "./hook-name"

type QuestionFetchResult =
  | { readonly kind: "pending"; readonly question: PendingQuestionTool }
  | { readonly kind: "not_pending" }
  | { readonly kind: "failed" }

type QuestionToolWaitingDependencies = {
  readonly enterWaitingOnHuman?: typeof enterWaitingOnHuman
  readonly resumeFromHuman?: typeof resumeFromHuman
}

function messageData(response: unknown): unknown[] {
  if (isRecord(response) && Array.isArray(response.data)) {
    return response.data
  }
  return Array.isArray(response) ? response : []
}

async function fetchLatestPendingQuestion(input: {
  readonly ctx: PluginInput
  readonly sessionID: string
}): Promise<QuestionFetchResult> {
  try {
    const messagesResponse = await input.ctx.client.session.messages({
      path: { id: input.sessionID },
      query: { directory: input.ctx.directory },
    })
    const question = latestAssistantTurnPendingQuestionTool(messageData(messagesResponse))
    return question === null ? { kind: "not_pending" } : { kind: "pending", question }
  } catch (error) {
    const loggedError = error instanceof Error ? { name: error.name, message: error.message } : String(error)
    log(`[${HOOK_NAME}] Question-tool messages fetch failed, skipping waiting promotion`, {
      sessionID: input.sessionID,
      error: loggedError,
    })
    return { kind: "failed" }
  }
}

function questionIsNoLongerPending(result: QuestionFetchResult, callID: string): boolean {
  return result.kind === "not_pending" || (result.kind === "pending" && result.question.callID !== callID)
}

export async function maybePromoteAtlasQuestionToolWaiting(
  input: {
    readonly ctx: PluginInput
    readonly sessionID: string
    readonly workId: string
  },
  dependencies: QuestionToolWaitingDependencies = {},
): Promise<boolean> {
  const expectedEpoch = currentResumeEpoch(input.ctx.directory, input.workId)
  const detected = await fetchLatestPendingQuestion(input)
  if (detected.kind !== "pending") {
    return false
  }

  const questionCallID = detected.question.callID
  const confirmed = await fetchLatestPendingQuestion(input)
  if (confirmed.kind !== "pending" || confirmed.question.callID !== questionCallID) {
    return false
  }

  const meta = { source: "question-tool", question_call_id: questionCallID } as const
  const enter = dependencies.enterWaitingOnHuman ?? enterWaitingOnHuman
  const resume = dependencies.resumeFromHuman ?? resumeFromHuman
  let remainsWaiting = false
  const accepted = await runPromotion(input.ctx.directory, input.workId, expectedEpoch, async (control) => {
    control.setInFlightMeta(meta)
    const persisted = enter(input.ctx.directory, input.workId, {
      reason: "agent asked the user a question via the question tool",
      source: meta.source,
      question_call_id: meta.question_call_id,
    })
    if (!persisted) {
      remainsWaiting = true
      return { meta, persisted }
    }

    const afterEnter = await fetchLatestPendingQuestion(input)
    if (questionIsNoLongerPending(afterEnter, questionCallID)) {
      const resumed = await control.advanceEpochAndResume(() => resume(input.ctx.directory, input.workId))
      remainsWaiting = !resumed
      return resumed ? null : { meta, persisted }
    }

    remainsWaiting = true
    return { meta, persisted }
  })
  if (!accepted) {
    return false
  }

  const closingRead = await fetchLatestPendingQuestion(input)
  if (questionIsNoLongerPending(closingRead, questionCallID)) {
    const recordedEpoch = await recordHumanResumeAndClearIfMatch(
      input.ctx.directory,
      input.workId,
      meta,
    )
    if (recordedEpoch !== null) {
      remainsWaiting = !resume(input.ctx.directory, input.workId)
    }
  }

  return remainsWaiting || isFailClosed(input.ctx.directory, input.workId)
}
