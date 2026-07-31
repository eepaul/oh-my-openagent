import { resumeFromHuman, type BoulderWaitingMetadata } from "@oh-my-opencode/boulder-state"
import {
  getWorkById,
  getWorkForSession,
  type BoulderWorkState,
} from "../../features/boulder-state"
import type { CompactionGraceTracker } from "./compaction-grace-tracker"
import {
  currentResumeEpoch,
  recordHumanResumeAndClearAtEpoch,
  recordHumanResumeAndClearIfMatchAtEpoch,
  runWaitingWorkCriticalSection,
} from "./waiting-fail-closed-gate"

type WaitingEpisodeSnapshot = {
  readonly since: string
  readonly source: BoulderWaitingMetadata["source"]
  readonly questionCallID: string | undefined
}

export type HumanResumeSnapshot = {
  readonly directory: string
  readonly sessionID: string
  readonly workID: string
  readonly messageID: string
  readonly expectedEpoch: number
  readonly waitingEpisode: WaitingEpisodeSnapshot | null
}

type CaptureHumanMessageResumeInput = {
  readonly directory: string
  readonly sessionID: string
  readonly messageID: string
}

type ScheduleHumanMessageResumeInput = {
  readonly tracker: CompactionGraceTracker
  readonly snapshot: HumanResumeSnapshot
}

type ResumeQuestionToolCompletionInput = {
  readonly directory: string
  readonly sessionID: string
  readonly questionCallID: string
  readonly beforeRevalidate?: () => Promise<void>
}

function captureWaitingEpisode(work: BoulderWorkState): WaitingEpisodeSnapshot | null {
  if (work.status !== "waiting_on_human" || work.waiting === undefined) {
    return null
  }
  return {
    since: work.waiting.since,
    source: work.waiting.source,
    questionCallID: work.waiting.question_call_id,
  }
}

function sameWaitingEpisode(
  work: BoulderWorkState | null,
  expected: WaitingEpisodeSnapshot | null,
): boolean {
  if (work?.status !== "waiting_on_human" || work.waiting === undefined || expected === null) {
    return false
  }
  return (
    work.waiting.since === expected.since
    && work.waiting.source === expected.source
    && work.waiting.question_call_id === expected.questionCallID
  )
}

function isStillBound(snapshot: HumanResumeSnapshot): boolean {
  return getWorkForSession(snapshot.directory, snapshot.sessionID)?.work_id === snapshot.workID
}

function captureResumeSnapshot(input: CaptureHumanMessageResumeInput): HumanResumeSnapshot | null {
  const work = getWorkForSession(input.directory, input.sessionID)
  if (work === null) {
    return null
  }
  return {
    directory: input.directory,
    sessionID: input.sessionID,
    workID: work.work_id,
    messageID: input.messageID,
    expectedEpoch: currentResumeEpoch(input.directory, work.work_id),
    waitingEpisode: captureWaitingEpisode(work),
  }
}

async function resumeRecordedSnapshot(
  snapshot: HumanResumeSnapshot,
  postRecordEpoch: number,
  beforeRevalidate?: () => Promise<void>,
): Promise<boolean> {
  if (beforeRevalidate !== undefined) {
    await beforeRevalidate()
  }
  const work = getWorkById(snapshot.directory, snapshot.workID)
  if (work?.status !== "waiting_on_human") {
    return true
  }
  if (!sameWaitingEpisode(work, snapshot.waitingEpisode)) {
    return true
  }

  return await runWaitingWorkCriticalSection(snapshot.directory, snapshot.workID, () => {
    if (currentResumeEpoch(snapshot.directory, snapshot.workID) !== postRecordEpoch) {
      return false
    }
    if (!isStillBound(snapshot)) {
      return false
    }
    if (!sameWaitingEpisode(getWorkById(snapshot.directory, snapshot.workID), snapshot.waitingEpisode)) {
      return false
    }
    return resumeFromHuman(snapshot.directory, snapshot.workID)
  })
}

async function resumeHumanMessage(snapshot: HumanResumeSnapshot): Promise<void> {
  if (!isStillBound(snapshot)) {
    return
  }
  const postRecordEpoch = await recordHumanResumeAndClearAtEpoch(
    snapshot.directory,
    snapshot.workID,
    snapshot.expectedEpoch,
  )
  if (postRecordEpoch === null) {
    return
  }
  await resumeRecordedSnapshot(snapshot, postRecordEpoch)
}

export function captureHumanMessageResume(
  input: CaptureHumanMessageResumeInput,
): HumanResumeSnapshot | null {
  return captureResumeSnapshot(input)
}

export function scheduleHumanMessageResume(input: ScheduleHumanMessageResumeInput): void {
  input.tracker.scheduleMessageResume({
    sessionID: input.snapshot.sessionID,
    messageID: input.snapshot.messageID,
    onFire: async () => await resumeHumanMessage(input.snapshot),
  })
}

export async function resumeQuestionToolCompletion(
  input: ResumeQuestionToolCompletionInput,
): Promise<boolean> {
  const snapshot = captureResumeSnapshot({
    directory: input.directory,
    sessionID: input.sessionID,
    messageID: `question:${input.questionCallID}`,
  })
  if (snapshot === null) {
    return false
  }
  const postRecordEpoch = await recordHumanResumeAndClearIfMatchAtEpoch(
    snapshot.directory,
    snapshot.workID,
    snapshot.expectedEpoch,
    { source: "question-tool", question_call_id: input.questionCallID },
  )
  if (postRecordEpoch === null) {
    return false
  }
  return await resumeRecordedSnapshot(snapshot, postRecordEpoch, input.beforeRevalidate)
}
