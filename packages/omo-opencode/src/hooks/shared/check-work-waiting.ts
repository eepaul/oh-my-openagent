import { readFileSync } from "node:fs"

import {
  checkPlanWaiting,
  enterWaitingOnHuman,
  resumeFromHuman,
  resolveBoulderPlanPathForWork,
} from "@oh-my-opencode/boulder-state"
import { getWorkById } from "../../features/boulder-state"
import { currentResumeEpoch, isFailClosed, runPromotion } from "./waiting-fail-closed-gate"

function describeBlockedTasks(planPath: string): string {
  try {
    const titles = readFileSync(planPath, "utf-8")
      .split(/\r?\n/)
      .flatMap((line) => {
        const match = line.match(/^\s*-\s*\[~\]\s*(.+?)\s*$/)
        return match === null ? [] : [match[1]]
      })
    if (titles.length > 0) {
      return `Blocked on human input for: ${titles.join("; ")}.`
    }
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error
    }
  }
  return "Blocked on human input for plan tasks."
}

function hasPersistedWaiting(work: object): boolean {
  return "waiting" in work && work.waiting !== undefined
}

export async function checkWorkWaiting(directory: string, workId: string): Promise<boolean> {
  for (;;) {
    const expectedEpoch = currentResumeEpoch(directory, workId)
    let finalWaiting = false
    const accepted = await runPromotion(directory, workId, expectedEpoch, async (control) => {
      const work = getWorkById(directory, workId)
      if (work === null) {
        finalWaiting = isFailClosed(directory, workId)
        return null
      }

      const verdict = checkPlanWaiting(directory, work)
      if (verdict.stale !== null) {
        const resumed = await control.advanceEpochAndResume(async () => resumeFromHuman(directory, workId))
        if (!resumed) {
          finalWaiting = true
          return null
        }
        const refreshed = getWorkById(directory, workId)
        finalWaiting = refreshed === null
          ? isFailClosed(directory, workId)
          : checkPlanWaiting(directory, refreshed).waiting || isFailClosed(directory, workId)
        return null
      }

      if (verdict.waiting && !hasPersistedWaiting(work)) {
        const planPath = resolveBoulderPlanPathForWork(directory, work)
        const meta = { source: "plan-blocked" } as const
        control.setInFlightMeta(meta)
        const persisted = enterWaitingOnHuman(directory, workId, {
          reason: describeBlockedTasks(planPath),
          source: meta.source,
        })
        finalWaiting = true
        return { meta, persisted }
      }

      if (hasPersistedWaiting(work)) {
        control.clearFailClosed()
      }
      finalWaiting = verdict.waiting || isFailClosed(directory, workId)
      return null
    })
    if (accepted) {
      return finalWaiting || isFailClosed(directory, workId)
    }
  }
}
