import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { enterWaitingOnHuman } from "@oh-my-opencode/boulder-state"
import { createBoulderState, getWorkById, writeBoulderState } from "../../features/boulder-state"
import { checkWorkWaiting } from "./check-work-waiting"
import { currentResumeEpoch, resetWaitingFailClosedGateForTesting } from "./waiting-fail-closed-gate"

describe("checkWorkWaiting", () => {
  let directory = ""
  let planPath = ""
  let workId = ""

  beforeEach(() => {
    directory = join(tmpdir(), `check-work-waiting-${randomUUID()}`)
    mkdirSync(directory, { recursive: true })
    planPath = join(directory, "plan.md")
    writeFileSync(planPath, "## TODOs\n- [ ] 1. Implement feature\n")
    const state = createBoulderState(planPath, "ses_waiting", "atlas")
    workId = state.active_work_id ?? ""
    writeBoulderState(directory, state)
  })

  afterEach(() => {
    resetWaitingFailClosedGateForTesting()
    if (existsSync(directory)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("#given active work with every plan task blocked #when checked #then it persists plan-blocked waiting", async () => {
    // given
    writeFileSync(planPath, "## TODOs\n- [~] 1. Await approval\n- [~] 2. Await credentials\n")

    // when
    const waiting = await checkWorkWaiting(directory, workId)

    // then
    expect(waiting).toBeTrue()
    expect(getWorkById(directory, workId)?.status).toBe("waiting_on_human")
    expect(getWorkById(directory, workId)?.waiting?.source).toBe("plan-blocked")
    expect(getWorkById(directory, workId)?.waiting?.reason).toContain("Await approval")
  })

  test("#given plan-blocked waiting becomes runnable #when checked #then it resumes and advances its epoch", async () => {
    // given
    writeFileSync(planPath, "## TODOs\n- [~] 1. Await approval\n")
    await checkWorkWaiting(directory, workId)
    writeFileSync(planPath, "## TODOs\n- [ ] 1. Implement feature\n")

    // when
    const waiting = await checkWorkWaiting(directory, workId)

    // then
    expect(waiting).toBeFalse()
    expect(getWorkById(directory, workId)?.status).toBe("active")
    expect(currentResumeEpoch(directory, workId)).toBe(1)
  })

  test("#given question-tool waiting with a runnable plan #when checked #then it remains waiting", async () => {
    // given
    const entered = enterWaitingOnHuman(directory, workId, {
      reason: "Awaiting answer",
      source: "question-tool",
      question_call_id: "call_question",
    })
    expect(entered).toBeTrue()

    // when
    const waiting = await checkWorkWaiting(directory, workId)

    // then
    expect(waiting).toBeTrue()
    expect(getWorkById(directory, workId)?.status).toBe("waiting_on_human")
  })
})
