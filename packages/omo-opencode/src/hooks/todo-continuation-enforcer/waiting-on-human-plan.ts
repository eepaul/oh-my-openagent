import type { PluginInput } from "@opencode-ai/plugin"
import { getPlanChecklist, isPlanWaitingOnHuman } from "@oh-my-opencode/boulder-state"

import {
  getWorkForSession,
  resolveBoulderPlanPathForWork,
} from "../../features/boulder-state"
import type {
  WaitingOnHumanNotificationInput,
  WaitingOnHumanNotifier,
} from "../shared/waiting-on-human-notifier"

export type WaitingOnHumanPlan = {
  readonly planPath: string
  readonly planName: string
  readonly blockedCount: number
}

export function getWaitingOnHumanPlan(
  planPath: string,
  planName: string,
): WaitingOnHumanPlan | undefined {
  if (!isPlanWaitingOnHuman(planPath)) {
    return undefined
  }

  return {
    planPath,
    planName,
    blockedCount: getPlanChecklist(planPath).blocked ?? 0,
  }
}

export function getWaitingOnHumanPlanForSession(
  directory: string,
  sessionID: string,
): WaitingOnHumanPlan | undefined {
  const boulderWork = getWorkForSession(directory, sessionID)
  if (!boulderWork) {
    return undefined
  }

  return getWaitingOnHumanPlan(
    resolveBoulderPlanPathForWork(directory, boulderWork),
    boulderWork.plan_name,
  )
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
    planPath: input.waitingPlan.planPath,
    planName: input.waitingPlan.planName,
    blockedCount: input.waitingPlan.blockedCount,
    preDispatchGuard: () =>
      input.isContinuationStopped?.(input.sessionID) !== true
      && getWaitingOnHumanPlanForSession(input.ctx.directory, input.sessionID)?.planPath === input.waitingPlan.planPath,
  })
}
