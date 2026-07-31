import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { enterWaitingOnHuman } from "@oh-my-opencode/boulder-state"
import { createBoulderState, getWorkById, writeBoulderState } from "../../features/boulder-state"
import { createCompactionGraceTracker } from "./compaction-grace-tracker"
import {
  captureHumanMessageResume,
  resumeQuestionToolCompletion,
  scheduleHumanMessageResume,
} from "./human-resume-controller"
import {
  armFailClosed,
  currentResumeEpoch,
  isFailClosed,
  resetWaitingFailClosedGateForTesting,
} from "./waiting-fail-closed-gate"

type ManualTask = {
  readonly run: () => Promise<void>
}

function createManualTracker(): {
  readonly tasks: ManualTask[]
  readonly tracker: ReturnType<typeof createCompactionGraceTracker>
} {
  const tasks: ManualTask[] = []
  const tracker = createCompactionGraceTracker({
    now: () => 1,
    schedule: (callback) => {
      tasks.push({ run: callback })
      return { cancel: () => {} }
    },
  })
  return { tasks, tracker }
}

describe("human resume controller", () => {
  let directory = ""
  let sessionID = ""
  let workId = ""

  beforeEach(() => {
    directory = join(tmpdir(), `human-resume-controller-${randomUUID()}`)
    mkdirSync(directory, { recursive: true })
    sessionID = `ses-${randomUUID()}`
    const planPath = join(directory, "plan.md")
    writeFileSync(planPath, "## TODOs\n- [ ] 1. Continue\n")
    const state = createBoulderState(planPath, sessionID, "atlas")
    workId = state.active_work_id ?? ""
    writeBoulderState(directory, state)
  })

  afterEach(() => {
    resetWaitingFailClosedGateForTesting()
    if (existsSync(directory)) rmSync(directory, { recursive: true, force: true })
  })

  test("#given a bound waiting work #when a delayed real-message resume fires #then it becomes active and removes waiting", async () => {
    // given
    expect(enterWaitingOnHuman(directory, workId, { reason: "Need approval", source: "plan-blocked" })).toBeTrue()
    const { tracker, tasks } = createManualTracker()
    const snapshot = captureHumanMessageResume({ directory, sessionID, messageID: "msg-1" })
    if (snapshot === null) throw new Error("expected bound work snapshot")
    scheduleHumanMessageResume({ tracker, snapshot })
    const task = tasks[0]
    if (task === undefined) throw new Error("expected delayed resume")

    // when
    await task.run()

    // then
    expect(getWorkById(directory, workId)?.status).toBe("active")
    expect(getWorkById(directory, workId)?.waiting).toBeUndefined()
  })

  test("#given an active bound work with an armed fail-closed gate #when a real message arrives #then it clears the gate and advances the epoch", async () => {
    // given
    await armFailClosed(directory, workId, { source: "plan-blocked" })
    const { tracker, tasks } = createManualTracker()
    const snapshot = captureHumanMessageResume({ directory, sessionID, messageID: "msg-1" })
    if (snapshot === null) throw new Error("expected bound work snapshot")
    scheduleHumanMessageResume({ tracker, snapshot })
    const task = tasks[0]
    if (task === undefined) throw new Error("expected delayed resume")

    // when
    await task.run()

    // then
    expect(isFailClosed(directory, workId)).toBeFalse()
    expect(currentResumeEpoch(directory, workId)).toBe(1)
    expect(getWorkById(directory, workId)?.status).toBe("active")
  })

  test("#given an unbound session #when it supplies a real message #then no resume snapshot is captured", () => {
    // given
    const unboundSessionID = `ses-${randomUUID()}`

    // when
    const snapshot = captureHumanMessageResume({ directory, sessionID: unboundSessionID, messageID: "msg-1" })

    // then
    expect(snapshot).toBeNull()
  })

  test("#given matching question-tool waiting #when its stable call ID completes #then it resumes without using message classification", async () => {
    // given
    expect(enterWaitingOnHuman(directory, workId, {
      reason: "Need answer",
      source: "question-tool",
      question_call_id: "call-question",
    })).toBeTrue()

    // when
    const resumed = await resumeQuestionToolCompletion({
      directory,
      sessionID,
      questionCallID: "call-question",
    })

    // then
    expect(resumed).toBeTrue()
    expect(getWorkById(directory, workId)?.status).toBe("active")
    expect(getWorkById(directory, workId)?.waiting).toBeUndefined()
  })

  test("#given plan-blocked waiting or a stale question call #when a question completion arrives #then it cannot change the episode", async () => {
    // given
    expect(enterWaitingOnHuman(directory, workId, { reason: "Need approval", source: "plan-blocked" })).toBeTrue()
    const initialEpoch = currentResumeEpoch(directory, workId)

    // when
    const resumed = await resumeQuestionToolCompletion({
      directory,
      sessionID,
      questionCallID: "part-id-only-match",
    })

    // then
    expect(resumed).toBeFalse()
    expect(getWorkById(directory, workId)?.status).toBe("waiting_on_human")
    expect(currentResumeEpoch(directory, workId)).toBe(initialEpoch)
  })

  test("#given question-tool waiting #when an old or duplicate call ID completes #then the current gate and epoch remain unchanged", async () => {
    // given
    expect(enterWaitingOnHuman(directory, workId, {
      reason: "Need answer",
      source: "question-tool",
      question_call_id: "call-current",
    })).toBeTrue()
    await armFailClosed(directory, workId, { source: "question-tool", question_call_id: "call-current" })
    const initialEpoch = currentResumeEpoch(directory, workId)

    // when
    const resumed = await resumeQuestionToolCompletion({
      directory,
      sessionID,
      questionCallID: "call-old",
    })

    // then
    expect(resumed).toBeFalse()
    expect(isFailClosed(directory, workId)).toBeTrue()
    expect(currentResumeEpoch(directory, workId)).toBe(initialEpoch)
  })

  test("#given an active work with only fail-closed question metadata #when its matching completion arrives #then it clears the gate without needing a user message", async () => {
    // given
    await armFailClosed(directory, workId, { source: "question-tool", question_call_id: "call-current" })

    // when
    const resumed = await resumeQuestionToolCompletion({
      directory,
      sessionID,
      questionCallID: "call-current",
    })

    // then
    expect(resumed).toBeTrue()
    expect(isFailClosed(directory, workId)).toBeFalse()
    expect(currentResumeEpoch(directory, workId)).toBe(1)
    expect(getWorkById(directory, workId)?.status).toBe("active")
  })
})
