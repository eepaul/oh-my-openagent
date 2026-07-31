import type { BoulderState, BoulderWaitingMetadata, BoulderWorkState } from "../types"
import { getBoulderWorks, readBoulderState } from "./read-state"
import { nowIsoString, projectWorkToMirror } from "./shared"
import { writeBoulderState } from "./write-state"

export function enterWaitingOnHuman(
  directory: string,
  workId: string,
  meta: {
    readonly reason: string
    readonly source: BoulderWaitingMetadata["source"]
    readonly question_call_id?: string
  },
): boolean {
  const state = readBoulderState(directory)
  if (!state) {
    return false
  }

  const works = getBoulderWorks(state)
  const work = works.find((candidate) => candidate.work_id === workId)
  if (!work) {
    return false
  }

  const updatedAt = nowIsoString()
  const updatedWork: BoulderWorkState = {
    ...work,
    status: "waiting_on_human",
    updated_at: updatedAt,
    waiting: {
      reason: meta.reason,
      since: work.status === "waiting_on_human" ? work.waiting?.since ?? updatedAt : updatedAt,
      source: meta.source,
      ...(meta.question_call_id !== undefined ? { question_call_id: meta.question_call_id } : {}),
    },
  }
  const nextState: BoulderState = {
    ...state,
    schema_version: 2,
    works: {
      ...Object.fromEntries(works.map((candidate) => [candidate.work_id, candidate])),
      [workId]: updatedWork,
    },
  }

  if (state.active_work_id === workId) {
    projectWorkToMirror(nextState, updatedWork)
  }

  return writeBoulderState(directory, nextState)
}

export function resumeFromHuman(directory: string, workId: string): boolean {
  const state = readBoulderState(directory)
  if (!state) {
    return false
  }

  const works = getBoulderWorks(state)
  const work = works.find((candidate) => candidate.work_id === workId)
  if (!work) {
    return false
  }

  if (work.status !== "waiting_on_human") {
    return true
  }

  const updatedWork: BoulderWorkState = {
    ...work,
    status: "active",
    updated_at: nowIsoString(),
  }
  delete updatedWork.waiting

  const nextState: BoulderState = {
    ...state,
    schema_version: 2,
    works: {
      ...Object.fromEntries(works.map((candidate) => [candidate.work_id, candidate])),
      [workId]: updatedWork,
    },
  }

  if (state.active_work_id === workId) {
    projectWorkToMirror(nextState, updatedWork)
  }

  return writeBoulderState(directory, nextState)
}
