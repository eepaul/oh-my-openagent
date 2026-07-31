import type { PluginInput } from "@opencode-ai/plugin"

import {
  getWorkForSession,
  resolveBoulderPlanPathForWork,
} from "../../features/boulder-state"
import { log } from "../../shared/logger"
import { isAwaitingFinalWaveApproval } from "../atlas/final-wave-gate-store"
import type { WaitingOnHumanNotifier } from "../shared/waiting-on-human-notifier"
import { HOOK_NAME } from "./constants"
import type { SessionStateStore } from "./session-state"
import {
  getWaitingOnHumanPlanForSession,
  notifyWaitingOnHuman,
} from "./waiting-on-human-plan"

export async function consumeBoulderIdleWaitingGate(input: {
  readonly ctx: PluginInput
  readonly sessionID: string
  readonly boulderWork: ReturnType<typeof getWorkForSession>
  readonly sessionStateStore: SessionStateStore
  readonly waitingOnHumanNotifier?: WaitingOnHumanNotifier
  readonly isContinuationStopped?: (sessionID: string) => boolean
}): Promise<boolean> {
  if (input.boulderWork === null) {
    return false
  }

  const planPath = resolveBoulderPlanPathForWork(input.ctx.directory, input.boulderWork)
  if (isAwaitingFinalWaveApproval(input.ctx.directory, input.boulderWork.work_id, planPath)) {
    log(`[${HOOK_NAME}] Skipped: boulder awaiting durable final-wave approval`, {
      sessionID: input.sessionID,
      workId: input.boulderWork.work_id,
    })
    return true
  }

  const waitingPlan = await getWaitingOnHumanPlanForSession(input.ctx.directory, input.sessionID)
  if (waitingPlan === undefined) {
    input.waitingOnHumanNotifier?.reset(input.sessionID)
    return false
  }

  input.sessionStateStore.cancelCountdown(input.sessionID)
  await notifyWaitingOnHuman({
    ctx: input.ctx,
    sessionID: input.sessionID,
    waitingPlan,
    notifier: input.waitingOnHumanNotifier,
    isContinuationStopped: input.isContinuationStopped,
  })
  log(`[${HOOK_NAME}] Skipped: boulder plan waiting on a human decision`, {
    sessionID: input.sessionID,
    planPath,
    blockedCount: waitingPlan.blockedCount,
  })
  return true
}
