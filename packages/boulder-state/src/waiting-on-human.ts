import { getPlanChecklist } from "./plan-checklist"
import { getPlanProgress } from "./storage/plan-progress"

export function isPlanWaitingOnHuman(planPath: string): boolean {
  const checklist = getPlanChecklist(planPath)
  return (checklist.blocked ?? 0) > 0 && checklist.remaining === 0
}

export function isPlanLifecycleComplete(planPath: string): boolean {
  return getPlanProgress(planPath).isComplete && !isPlanWaitingOnHuman(planPath)
}
