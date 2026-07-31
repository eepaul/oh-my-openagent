import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { enterWaitingOnHuman } from "@oh-my-opencode/boulder-state"
import { addBoulderWork, createBoulderState, getWorkById, writeBoulderState } from "../../features/boulder-state"
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

type ManualTask = { readonly run: () => Promise<void> }

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

describe("human resume controller races", () => {
  let directory = ""
  let sessionID = ""
  let workID = ""

  beforeEach(() => {
    directory = join(tmpdir(), `human-resume-race-${randomUUID()}`)
    mkdirSync(directory, { recursive: true })
    sessionID = `ses-${randomUUID()}`
    const planPath = join(directory, "plan-a.md")
    writeFileSync(planPath, "## TODOs\n- [ ] 1. Continue\n")
    const state = createBoulderState(planPath, sessionID, "atlas")
    workID = state.active_work_id ?? ""
    writeBoulderState(directory, state)
  })

  afterEach(() => {
    resetWaitingFailClosedGateForTesting()
    if (existsSync(directory)) rmSync(directory, { recursive: true, force: true })
  })

  test("#given one message reaches both observers across a new waiting episode #when its second delayed delivery arrives #then the tombstone leaves the new episode intact", async () => {
    // given
    expect(enterWaitingOnHuman(directory, workID, { reason: "A", source: "plan-blocked" })).toBeTrue()
    const { tracker, tasks } = createManualTracker()
    const snapshot = captureHumanMessageResume({ directory, sessionID, messageID: "msg-1" })
    if (snapshot === null) throw new Error("expected first episode snapshot")
    scheduleHumanMessageResume({ tracker, snapshot })
    const task = tasks[0]
    if (task === undefined) throw new Error("expected first delayed resume")
    await task.run()
    expect(enterWaitingOnHuman(directory, workID, { reason: "B", source: "plan-blocked" })).toBeTrue()
    await armFailClosed(directory, workID, { source: "plan-blocked" })

    // when
    scheduleHumanMessageResume({ tracker, snapshot })

    // then
    expect(tasks).toHaveLength(1)
    expect(getWorkById(directory, workID)?.status).toBe("waiting_on_human")
    expect(isFailClosed(directory, workID)).toBeTrue()
    expect(currentResumeEpoch(directory, workID)).toBe(1)
  })

  test("#given a waiting work is rebound before its delay fires #when the old message executes #then it cannot touch the replacement work", async () => {
    // given
    expect(enterWaitingOnHuman(directory, workID, { reason: "A", source: "plan-blocked" })).toBeTrue()
    const { tracker, tasks } = createManualTracker()
    const snapshot = captureHumanMessageResume({ directory, sessionID, messageID: "msg-1" })
    if (snapshot === null) throw new Error("expected first episode snapshot")
    scheduleHumanMessageResume({ tracker, snapshot })
    const task = tasks[0]
    if (task === undefined) throw new Error("expected delayed resume")
    const nextPlanPath = join(directory, "plan-b.md")
    writeFileSync(nextPlanPath, "## TODOs\n- [ ] 1. Continue\n")
    const rebound = addBoulderWork(directory, {
      planPath: nextPlanPath,
      sessionId: sessionID,
      startedAt: "2030-01-01T00:00:00.000Z",
    })
    const reboundWorkID = rebound?.active_work_id
    if (reboundWorkID === undefined) throw new Error("expected rebound work")
    expect(enterWaitingOnHuman(directory, reboundWorkID, { reason: "B", source: "plan-blocked" })).toBeTrue()
    await armFailClosed(directory, reboundWorkID, { source: "plan-blocked" })

    // when
    await task.run()

    // then
    expect(getWorkById(directory, reboundWorkID)?.status).toBe("waiting_on_human")
    expect(isFailClosed(directory, reboundWorkID)).toBeTrue()
    expect(currentResumeEpoch(directory, reboundWorkID)).toBe(0)
  })

  test("#given question A is completed before an older delayed message fires #when question B establishes a new episode #then the old arrival-time epoch CAS drops it", async () => {
    // given
    expect(enterWaitingOnHuman(directory, workID, {
      reason: "A",
      source: "question-tool",
      question_call_id: "call-a",
    })).toBeTrue()
    const { tracker, tasks } = createManualTracker()
    const snapshot = captureHumanMessageResume({ directory, sessionID, messageID: "msg-a" })
    if (snapshot === null) throw new Error("expected first episode snapshot")
    scheduleHumanMessageResume({ tracker, snapshot })
    const task = tasks[0]
    if (task === undefined) throw new Error("expected delayed resume")
    await resumeQuestionToolCompletion({ directory, sessionID, questionCallID: "call-a" })
    expect(enterWaitingOnHuman(directory, workID, { reason: "B", source: "plan-blocked" })).toBeTrue()
    await armFailClosed(directory, workID, { source: "plan-blocked" })

    // when
    await task.run()

    // then
    expect(getWorkById(directory, workID)?.status).toBe("waiting_on_human")
    expect(isFailClosed(directory, workID)).toBeTrue()
    expect(currentResumeEpoch(directory, workID)).toBe(1)
  })

  test("#given question A pauses after recording its resume #when question B replaces the episode before lock-tail revalidation #then A cannot resume B", async () => {
    // given
    expect(enterWaitingOnHuman(directory, workID, {
      reason: "A",
      source: "question-tool",
      question_call_id: "call-a",
    })).toBeTrue()
    const beforeRevalidate = Promise.withResolvers<void>()
    const releaseRevalidate = Promise.withResolvers<void>()
    const completion = resumeQuestionToolCompletion({
      directory,
      sessionID,
      questionCallID: "call-a",
      beforeRevalidate: async () => {
        beforeRevalidate.resolve()
        await releaseRevalidate.promise
      },
    })
    await beforeRevalidate.promise
    expect(enterWaitingOnHuman(directory, workID, {
      reason: "B",
      source: "question-tool",
      question_call_id: "call-b",
    })).toBeTrue()
    await armFailClosed(directory, workID, { source: "question-tool", question_call_id: "call-b" })

    // when
    releaseRevalidate.resolve()
    await completion

    // then
    expect(getWorkById(directory, workID)?.waiting?.question_call_id).toBe("call-b")
    expect(isFailClosed(directory, workID)).toBeTrue()
    expect(currentResumeEpoch(directory, workID)).toBe(1)
  })
})
