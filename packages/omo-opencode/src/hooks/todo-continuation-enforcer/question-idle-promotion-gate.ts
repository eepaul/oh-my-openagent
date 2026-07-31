import type { PluginInput } from "@opencode-ai/plugin"

import { getWorkForSession } from "../../features/boulder-state"
import { normalizeSDKResponse } from "../../shared"
import { log } from "../../shared/logger"
import { currentResumeEpoch } from "../shared/waiting-fail-closed-gate"
import { HOOK_NAME } from "./constants"
import { hasUnansweredQuestion } from "./pending-question-detection"
import type { MessageWithInfo } from "./types"
import { promotePendingQuestionWaiting } from "./waiting-on-human-plan"

export async function consumeQuestionIdlePromotion(input: {
  readonly ctx: PluginInput
  readonly sessionID: string
  readonly boulderWork: ReturnType<typeof getWorkForSession>
  readonly messages: MessageWithInfo[]
}): Promise<MessageWithInfo[] | null> {
  if (!hasUnansweredQuestion(input.messages)) {
    return input.messages
  }
  if (input.boulderWork === null) {
    log(`[${HOOK_NAME}] Skipped: pending question awaiting user response`, { sessionID: input.sessionID })
    return null
  }

  const waiting = await promotePendingQuestionWaiting({
    ctx: input.ctx,
    sessionID: input.sessionID,
    workId: input.boulderWork.work_id,
    expectedEpoch: currentResumeEpoch(input.ctx.directory, input.boulderWork.work_id),
    messages: input.messages,
  })
  if (waiting) {
    log(`[${HOOK_NAME}] Skipped: pending question awaiting user response`, { sessionID: input.sessionID })
    return null
  }

  const response = await input.ctx.client.session.messages({
    path: { id: input.sessionID },
    query: { directory: input.ctx.directory },
  })
  return normalizeSDKResponse<MessageWithInfo[]>(response, [])
}
