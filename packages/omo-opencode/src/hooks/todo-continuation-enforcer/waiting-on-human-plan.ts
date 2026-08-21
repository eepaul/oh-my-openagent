import type { PluginInput } from "@opencode-ai/plugin"
import {
  checkPlanWaiting,
  enterWaitingOnHuman,
  getPlanChecklist,
  resumeFromHuman,
} from "@oh-my-opencode/boulder-state"
import { latestAssistantTurnPendingQuestionTool } from "@oh-my-opencode/utils"

import {
  getWorkById,
  getWorkForSession,
  resolveBoulderPlanPathForWork,
} from "../../features/boulder-state"
import { normalizeSDKResponse } from "../../shared"
import { checkWorkWaiting } from "../shared/check-work-waiting"
import {
  isFailClosed,
  recordHumanResumeAndClearIfMatch,
  runPromotion,
} from "../shared/waiting-fail-closed-gate"
import type {
  WaitingOnHumanNotificationInput,
  WaitingOnHumanNotifier,
} from "../shared/waiting-on-human-notifier"

export type WaitingOnHumanPlan = {
  readonly planPath: string
  readonly planName: string
  readonly blockedCount: number
  readonly workId: string
  readonly waitingSince?: string
}

function getWaitingOnHumanPlan(input: {
  readonly planPath: string
  readonly planName: string
  readonly workId: string
  readonly waitingSince?: string
}): WaitingOnHumanPlan {
  return {
    planPath: input.planPath,
    planName: input.planName,
    blockedCount: getPlanChecklist(input.planPath).blocked ?? 0,
    workId: input.workId,
    ...(input.waitingSince === undefined ? {} : { waitingSince: input.waitingSince }),
  }
}

export function isBoulderSessionWaitingOnHuman(
  directory: string,
  sessionID: string,
): boolean {
  const work = getWorkForSession(directory, sessionID)
  if (work === null) {
    return false
  }

  return isFailClosed(directory, work.work_id) || checkPlanWaiting(directory, work).waiting
}

export async function getWaitingOnHumanPlanForSession(
  directory: string,
  sessionID: string,
): Promise<WaitingOnHumanPlan | undefined> {
  const boulderWork = getWorkForSession(directory, sessionID)
  if (boulderWork === null) {
    return undefined
  }

  const waiting = await checkWorkWaiting(directory, boulderWork.work_id)
  if (!waiting && !isFailClosed(directory, boulderWork.work_id)) {
    return undefined
  }

  const freshWork = getWorkById(directory, boulderWork.work_id) ?? boulderWork
  return getWaitingOnHumanPlan({
    planPath: resolveBoulderPlanPathForWork(directory, freshWork),
    planName: freshWork.plan_name,
    workId: freshWork.work_id,
    waitingSince: freshWork.waiting?.since,
  })
}

async function findPendingQuestionCallIDForSession(
  ctx: PluginInput,
  sessionID: string,
): Promise<string | undefined> {
  const response = await ctx.client.session.messages({
    path: { id: sessionID },
    query: { directory: ctx.directory },
  })
  return latestAssistantTurnPendingQuestionTool(normalizeSDKResponse<unknown[]>(response, []))?.callID
}

async function isQuestionStillPending(input: {
  readonly ctx: PluginInput
  readonly sessionID: string
  readonly callID: string
}): Promise<boolean> {
  return (await findPendingQuestionCallIDForSession(input.ctx, input.sessionID)) === input.callID
}

export async function promotePendingQuestionWaiting(input: {
  readonly ctx: PluginInput
  readonly sessionID: string
  readonly workId: string
  readonly expectedEpoch: number
  readonly messages: readonly unknown[]
}): Promise<boolean> {
  const questionCallID = latestAssistantTurnPendingQuestionTool([...input.messages])?.callID
  if (questionCallID === undefined) {
    return true
  }

  const meta = { source: "question-tool", question_call_id: questionCallID } as const
  await runPromotion(input.ctx.directory, input.workId, input.expectedEpoch, async (control) => {
    if (getWorkById(input.ctx.directory, input.workId) === null) {
      return null
    }
    if (!await isQuestionStillPending({ ctx: input.ctx, sessionID: input.sessionID, callID: questionCallID })) {
      return null
    }

    control.setInFlightMeta(meta)
    const persisted = enterWaitingOnHuman(input.ctx.directory, input.workId, {
      reason: `Awaiting a response to question call ${questionCallID}.`,
      source: meta.source,
      question_call_id: meta.question_call_id,
    })
    if (persisted && !await isQuestionStillPending({ ctx: input.ctx, sessionID: input.sessionID, callID: questionCallID })) {
      await control.advanceEpochAndResume(async () => resumeFromHuman(input.ctx.directory, input.workId))
    }
    return { meta, persisted }
  })

  const remainsPending = await isQuestionStillPending({
    ctx: input.ctx,
    sessionID: input.sessionID,
    callID: questionCallID,
  })
  if (!remainsPending) {
    await recordHumanResumeAndClearIfMatch(input.ctx.directory, input.workId, meta)
  }
  return remainsPending || isFailClosed(input.ctx.directory, input.workId)
}

function createWaitingOnHumanClient(
  ctx: PluginInput,
): WaitingOnHumanNotificationInput["client"] {
  return {
    session: {
      status: async () => ctx.client.session.status(),
      messages: async (input) => ctx.client.session.messages({
        path: { ...input.path },
        query: { ...input.query },
      }),
      promptAsync: async (input) => ctx.client.session.promptAsync({
        path: { ...input.path },
        body: { ...input.body, parts: [...input.body.parts] },
        query: { ...input.query },
      }),
    },
  }
}

export async function notifyWaitingOnHuman(input: {
  readonly ctx: PluginInput
  readonly sessionID: string
  readonly waitingPlan: WaitingOnHumanPlan
  readonly notifier?: WaitingOnHumanNotifier
  readonly isContinuationStopped?: (sessionID: string) => boolean
}): Promise<void> {
  await input.notifier?.maybeNotify({
    client: createWaitingOnHumanClient(input.ctx),
    directory: input.ctx.directory,
    sessionID: input.sessionID,
    workId: input.waitingPlan.workId,
    ...(input.waitingPlan.waitingSince === undefined ? {} : { waitingSince: input.waitingPlan.waitingSince }),
    planPath: input.waitingPlan.planPath,
    planName: input.waitingPlan.planName,
    blockedCount: input.waitingPlan.blockedCount,
    shouldDispatch: () =>
      input.isContinuationStopped?.(input.sessionID) !== true
      && isBoulderSessionWaitingOnHuman(input.ctx.directory, input.sessionID),
  })
}
