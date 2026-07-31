import { readFileSync } from "node:fs"

import { parsePlanChecklist } from "./plan-checklist"
import { resolveBoulderPlanPathForWork } from "./storage/path"
import type { BoulderWorkState } from "./types"
import { isPlanLifecycleComplete } from "./waiting-on-human"

export type PlanWaitingShape = "waiting" | "runnable" | "unreadable"

export function readPlanWaitingShape(planPath: string): PlanWaitingShape {
  try {
    const checklist = parsePlanChecklist(readFileSync(planPath, "utf-8"))
    const blocked = checklist.blocked ?? 0
    if (checklist.total === 0 && blocked === 0) {
      return "unreadable"
    }
    if (blocked > 0 && checklist.remaining === 0) {
      return "waiting"
    }
    if (checklist.remaining > 0 || blocked === 0) {
      return "runnable"
    }
    return "unreadable"
  } catch (error) {
    if (error instanceof Error) {
      return "unreadable"
    }
    throw error
  }
}

export function checkPlanWaiting(
  directory: string,
  work: BoulderWorkState,
): { waiting: boolean; stale: "runnable" | "complete" | null } {
  const planPath = resolveBoulderPlanPathForWork(directory, work)
  const shape = readPlanWaitingShape(planPath)
  const waiting = work.status === "waiting_on_human" || shape === "waiting"
  const isPlanBlockedWaiting = work.status === "waiting_on_human" && work.waiting?.source === "plan-blocked"

  if (!isPlanBlockedWaiting || shape === "unreadable") {
    return { waiting, stale: null }
  }

  if (isPlanLifecycleComplete(planPath)) {
    return { waiting, stale: "complete" }
  }

  // Oscillation invariant: plan-blocked enters only for "waiting" and reports stale only for "runnable".
  if (shape === "runnable") {
    return { waiting, stale: "runnable" }
  }

  return { waiting, stale: null }
}
