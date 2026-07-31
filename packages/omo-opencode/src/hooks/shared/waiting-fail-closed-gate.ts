import { resolve } from "node:path"

import { getWorkById } from "../../features/boulder-state"

export type WaitingFailClosedMeta = {
  readonly source: "plan-blocked" | "question-tool"
  readonly question_call_id?: string
}

type WorkGateState = {
  resumeEpoch: number
  failClosed: WaitingFailClosedMeta | undefined
  inFlight: WaitingFailClosedMeta | undefined
  queue: Promise<void>
}

export type PromotionControl = {
  readonly setInFlightMeta: (meta: WaitingFailClosedMeta) => void
  readonly clearFailClosed: () => void
  readonly advanceEpochAndResume: (resume: () => boolean | Promise<boolean>) => Promise<boolean>
}

type PromotionWrite = {
  readonly meta: WaitingFailClosedMeta
  readonly persisted: boolean
}

const workStates = new Map<string, Map<string, WorkGateState>>()

function canonicalDirectory(directory: string): string {
  return resolve(directory)
}

function getWorkState(directory: string, workId: string): WorkGateState {
  const normalizedDirectory = canonicalDirectory(directory)
  let statesForDirectory = workStates.get(normalizedDirectory)
  if (statesForDirectory === undefined) {
    statesForDirectory = new Map<string, WorkGateState>()
    workStates.set(normalizedDirectory, statesForDirectory)
  }

  let state = statesForDirectory.get(workId)
  if (state === undefined) {
    state = { resumeEpoch: 0, failClosed: undefined, inFlight: undefined, queue: Promise.resolve() }
    statesForDirectory.set(workId, state)
  }
  return state
}

function getExistingWorkState(directory: string, workId: string): WorkGateState | undefined {
  return workStates.get(canonicalDirectory(directory))?.get(workId)
}

export async function runWaitingWorkCriticalSection<TResult>(
  directory: string,
  workId: string,
  operation: (control: PromotionControl, state: WorkGateState) => TResult | Promise<TResult>,
): Promise<TResult> {
  const state = getWorkState(directory, workId)
  const previous = state.queue
  const complete = Promise.withResolvers<void>()
  state.queue = previous.then(() => complete.promise, () => complete.promise)
  await previous
  try {
    const control: PromotionControl = {
      setInFlightMeta: (meta) => {
        state.inFlight = meta
      },
      clearFailClosed: () => {
        state.failClosed = undefined
      },
      advanceEpochAndResume: async (resume) => {
        const resumed = await resume()
        if (resumed) {
          state.resumeEpoch += 1
        }
        return resumed
      },
    }
    return await operation(control, state)
  } finally {
    complete.resolve()
  }
}

export async function armFailClosed(
  directory: string,
  workId: string,
  meta: WaitingFailClosedMeta,
): Promise<void> {
  await runWaitingWorkCriticalSection(directory, workId, async (_control, state) => {
    state.failClosed = meta
  })
}

export async function clearFailClosed(directory: string, workId: string): Promise<void> {
  await runWaitingWorkCriticalSection(directory, workId, async (_control, state) => {
    state.failClosed = undefined
  })
}

export function isFailClosed(directory: string, workId: string): boolean {
  return getExistingWorkState(directory, workId)?.failClosed !== undefined
}

export function currentResumeEpoch(directory: string, workId: string): number {
  return getExistingWorkState(directory, workId)?.resumeEpoch ?? 0
}

export async function runPromotion(
  directory: string,
  workId: string,
  expectedEpoch: number,
  fn: (control: PromotionControl) => PromotionWrite | null | Promise<PromotionWrite | null>,
): Promise<boolean> {
  return await runWaitingWorkCriticalSection(directory, workId, async (control, state) => {
    if (state.resumeEpoch !== expectedEpoch) {
      return false
    }

    const result = await fn(control)
    if (result === null) {
      state.inFlight = undefined
      return true
    }
    state.inFlight = result.meta
    if (result.persisted) {
      state.failClosed = undefined
    } else {
      state.failClosed = result.meta
    }
    state.inFlight = undefined
    return true
  })
}

export async function recordHumanResumeAndClear(directory: string, workId: string): Promise<number> {
  return await runWaitingWorkCriticalSection(directory, workId, async (_control, state) => {
    state.resumeEpoch += 1
    state.failClosed = undefined
    return state.resumeEpoch
  })
}

export async function recordHumanResumeAndClearAtEpoch(
  directory: string,
  workId: string,
  expectedEpoch: number,
): Promise<number | null> {
  return await runWaitingWorkCriticalSection(directory, workId, async (_control, state) => {
    if (state.resumeEpoch !== expectedEpoch) {
      return null
    }
    state.resumeEpoch += 1
    state.failClosed = undefined
    return state.resumeEpoch
  })
}

function matches(meta: WaitingFailClosedMeta | undefined, match: WaitingFailClosedMeta): boolean {
  return meta?.source === match.source && meta.question_call_id === match.question_call_id
}

function persistedWaitingMeta(work: object | null): WaitingFailClosedMeta | undefined {
  if (work === null || !("waiting" in work) || typeof work.waiting !== "object" || work.waiting === null) {
    return undefined
  }
  const waiting = work.waiting
  if (!("source" in waiting) || typeof waiting.source !== "string") {
    return undefined
  }
  if (waiting.source !== "plan-blocked" && waiting.source !== "question-tool") {
    return undefined
  }
  const callId = "question_call_id" in waiting && typeof waiting.question_call_id === "string"
    ? waiting.question_call_id
    : undefined
  return { source: waiting.source, ...(callId === undefined ? {} : { question_call_id: callId }) }
}

export async function recordHumanResumeAndClearIfMatch(
  directory: string,
  workId: string,
  match: Required<WaitingFailClosedMeta>,
): Promise<number | null> {
  return await runWaitingWorkCriticalSection(directory, workId, async (_control, state) => {
    const persistedWaiting = persistedWaitingMeta(getWorkById(directory, workId))
    if (!matches(persistedWaiting, match) && !matches(state.failClosed, match) && !matches(state.inFlight, match)) {
      return null
    }
    state.resumeEpoch += 1
    state.failClosed = undefined
    return state.resumeEpoch
  })
}

export async function recordHumanResumeAndClearIfMatchAtEpoch(
  directory: string,
  workId: string,
  expectedEpoch: number,
  match: Required<WaitingFailClosedMeta>,
): Promise<number | null> {
  return await runWaitingWorkCriticalSection(directory, workId, async (_control, state) => {
    if (state.resumeEpoch !== expectedEpoch) {
      return null
    }
    const persistedWaiting = persistedWaitingMeta(getWorkById(directory, workId))
    if (!matches(persistedWaiting, match) && !matches(state.failClosed, match) && !matches(state.inFlight, match)) {
      return null
    }
    state.resumeEpoch += 1
    state.failClosed = undefined
    return state.resumeEpoch
  })
}

export function resetWaitingFailClosedGateForTesting(): void {
  workStates.clear()
}
