import {
  findPrometheusPlans,
  getPlanName,
  getPlanProgress,
  getWorkByPlanName,
  getWorkResumeOptions,
} from "../../features/boulder-state"
import { isPlanLifecycleComplete } from "@oh-my-opencode/boulder-state"
import { log } from "../../shared/logger"
import { HOOK_NAME } from "./start-work-hook"
import {
  buildAutoSelectedPlanContextInfoOnly,
  buildExistingSessionContext,
  buildWorkResumeRetryContext,
} from "./context-info-formatters"
import { buildMissingPlanContext, findPlanByName } from "./plan-selection"
import { selectWorkForStartWork } from "./selected-work-resume"
import { createNewWorkOrInitialize } from "./work-initializer"

export async function buildExplicitPlanContext(params: {
  readonly explicitPlanName: string
  readonly sessionId: string
  readonly timestamp: string
  readonly activeAgent: string
  readonly worktreePath: string | undefined
  readonly worktreeBlock: string
  readonly directory: string
}): Promise<string> {
  const { explicitPlanName, sessionId, timestamp, activeAgent, worktreePath, worktreeBlock, directory } =
    params
  log(`[${HOOK_NAME}] Explicit plan name requested: ${explicitPlanName}`, { sessionID: sessionId })

  const matchedWork = getWorkByPlanName(directory, explicitPlanName, { worktreePath })
  if (matchedWork) {
    const matchedWorkProgress = getPlanProgress(matchedWork.active_plan)
    if (isPlanLifecycleComplete(matchedWork.active_plan)) {
      return buildPlanAlreadyCompleteContext({
        planName: matchedWork.plan_name,
        totalTasks: matchedWorkProgress.total,
      })
    }

    const selection = await selectWorkForStartWork({ directory, workId: matchedWork.work_id })
    if (selection.kind === "selected") {
      return buildExistingSessionContext({
        existingState: selection.state,
        sessionId,
        activeAgent,
        worktreePath,
        worktreeBlock,
        directory,
        resumedFromHuman: selection.resumedFromHuman,
      })
    }
    return buildWorkResumeRetryContext({ planName: matchedWork.plan_name, reason: selection.reason })
  }

  const allPlans = findPrometheusPlans(directory)
  const matchedPlan = findPlanByName(allPlans, explicitPlanName)
  if (!matchedPlan) {
    const incompletePlans = allPlans.filter((planPath) => !isPlanLifecycleComplete(planPath))
    if (incompletePlans.length === 1) {
      createNewWorkOrInitialize({
        directory,
        planPath: incompletePlans[0],
        sessionId,
        activeAgent,
        worktreePath,
      })

      return buildAutoSelectedPlanContextInfoOnly({
        planPath: incompletePlans[0],
        sessionId,
        timestamp,
        worktreeBlock,
        reason: `Only incomplete plan available after "${explicitPlanName}" did not match any plan`,
      })
    }

    return buildMissingPlanContext(explicitPlanName, allPlans, getWorkResumeOptions(directory))
  }

  const progress = getPlanProgress(matchedPlan)
  if (isPlanLifecycleComplete(matchedPlan)) {
    return buildPlanAlreadyCompleteContext({
      planName: getPlanName(matchedPlan),
      totalTasks: progress.total,
    })
  }

  createNewWorkOrInitialize({
    directory,
    planPath: matchedPlan,
    sessionId,
    activeAgent,
    worktreePath,
  })

  return buildAutoSelectedPlanContextInfoOnly({
    planPath: matchedPlan,
    sessionId,
    timestamp,
    worktreeBlock,
  })
}

function buildPlanAlreadyCompleteContext(params: {
  readonly planName: string
  readonly totalTasks: number
}): string {
  const { planName, totalTasks } = params

  return `
## Plan Already Complete

 The requested plan "${planName}" has been completed.
 All ${totalTasks} tasks are done. Create a new plan using the Prometheus agent.`
}
