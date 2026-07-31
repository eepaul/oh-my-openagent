import {
  getPlanChecklist,
  getWorkForSession,
  resolveBoulderPlanPathForWork,
  type BoulderWorkState,
  type PlanChecklist,
} from "@oh-my-opencode/boulder-state"

export interface ContinuableWork {
  readonly work: BoulderWorkState
  readonly planPath: string
  readonly checklist: PlanChecklist
}

export function findContinuableBoulderWork(
  cwd: string,
  sessionId: string,
): ContinuableWork | null {
  const work = getWorkForSession(cwd, `senpi:${sessionId}`)
  if (!work) {
    return null
  }

  switch (work.status) {
    case "active":
    case "paused":
      break
    case "completed":
    case "abandoned":
    case "waiting_on_human":
    case undefined:
      return null
    default:
      return null
  }

  const planPath = resolveBoulderPlanPathForWork(cwd, work)
  const checklist = getPlanChecklist(planPath)
  if (checklist.total <= 0) {
    return null
  }

  return { work, planPath, checklist }
}
