import {
  getWorkById,
  selectActiveWork,
} from "../../features/boulder-state"
import { resumeFromHuman } from "@oh-my-opencode/boulder-state"
import type { BoulderState, BoulderWorkState } from "../../features/boulder-state"
import {
  currentResumeEpoch,
  recordHumanResumeAndClear,
  runWaitingWorkCriticalSection,
} from "../shared/waiting-fail-closed-gate"

type WaitingEpisode = {
  readonly workId: string
  readonly since: string
}

type ResumeDependencies = {
  readonly resumeFromHuman: (directory: string, workId: string) => boolean
}

export type SelectedWorkResumeResult =
  | {
    readonly kind: "selected"
    readonly state: BoulderState
    readonly resumedFromHuman: boolean
  }
  | {
    readonly kind: "retryable-error"
    readonly reason: "newer-waiting-episode" | "resume-write-failed" | "work-not-found" | "selection-write-failed"
  }

const defaultResumeDependencies: ResumeDependencies = { resumeFromHuman }

function captureWaitingEpisode(work: BoulderWorkState | null): WaitingEpisode | null {
  if (work?.status !== "waiting_on_human" || work.waiting === undefined) {
    return null
  }

  return { workId: work.work_id, since: work.waiting.since }
}

function hasSameWaitingEpisode(work: BoulderWorkState, episode: WaitingEpisode | null): boolean {
  return episode !== null
    && work.status === "waiting_on_human"
    && work.work_id === episode.workId
    && work.waiting?.since === episode.since
}

export async function selectWorkForStartWork(
  input: { readonly directory: string; readonly workId: string },
  dependencies: ResumeDependencies = defaultResumeDependencies,
): Promise<SelectedWorkResumeResult> {
  const { directory, workId } = input
  const selectedEpisode = captureWaitingEpisode(getWorkById(directory, workId))
  const postRecordEpoch = await recordHumanResumeAndClear(directory, workId)

  return await runWaitingWorkCriticalSection(directory, workId, async () => {
    if (currentResumeEpoch(directory, workId) !== postRecordEpoch) {
      return { kind: "retryable-error", reason: "newer-waiting-episode" }
    }

    const freshWork = getWorkById(directory, workId)
    if (freshWork === null) {
      return { kind: "retryable-error", reason: "work-not-found" }
    }

    let resumedFromHuman = false
    if (freshWork.status === "waiting_on_human") {
      if (!hasSameWaitingEpisode(freshWork, selectedEpisode)) {
        return { kind: "retryable-error", reason: "newer-waiting-episode" }
      }

      if (!dependencies.resumeFromHuman(directory, workId)) {
        return { kind: "retryable-error", reason: "resume-write-failed" }
      }
      resumedFromHuman = true
    }

    const state = selectActiveWork(directory, workId)
    if (state === null) {
      return { kind: "retryable-error", reason: "selection-write-failed" }
    }

    return { kind: "selected", state, resumedFromHuman }
  })
}
