import { afterEach, describe, expect, test } from "bun:test"

import {
  armFailClosed,
  currentResumeEpoch,
  isFailClosed,
  recordHumanResumeAndClear,
  recordHumanResumeAndClearIfMatch,
  resetWaitingFailClosedGateForTesting,
  runPromotion,
} from "./waiting-fail-closed-gate"

const question = { source: "question-tool", question_call_id: "call_current" } as const
const planBlocked = { source: "plan-blocked" } as const

describe("waiting fail-closed gate interleavings six through ten", () => {
  afterEach(() => {
    resetWaitingFailClosedGateForTesting()
  })

  test("#given a new gate is armed after a human resume records #when the old resume returns #then it does not clear the new gate", async () => {
    // given
    await recordHumanResumeAndClear("/workspace", "work")

    // when
    await armFailClosed("/workspace", "work", planBlocked)

    // then
    expect(isFailClosed("/workspace", "work")).toBeTrue()
  })

  test("#given P1 self-corrects inside its promotion lock #when P2 carries P1's old epoch #then P2 is dropped", async () => {
    // given
    const epoch = currentResumeEpoch("/workspace", "work")
    const first = await runPromotion("/workspace", "work", epoch, async (control) => {
      await control.advanceEpochAndResume(async () => true)
      return { meta: planBlocked, persisted: true }
    })

    // when
    const second = await runPromotion("/workspace", "work", epoch, async () => ({
      meta: planBlocked,
      persisted: true,
    }))

    // then
    expect(first).toBeTrue()
    expect(second).toBeFalse()
    expect(currentResumeEpoch("/workspace", "work")).toBe(1)
  })

  test("#given an unrelated question completion #when its stable call id differs #then neither gate nor epoch changes", async () => {
    // given
    await armFailClosed("/workspace", "work", question)

    // when
    const recorded = await recordHumanResumeAndClearIfMatch("/workspace", "work", {
      source: "question-tool",
      question_call_id: "call_old",
    })

    // then
    expect(recorded).toBeNull()
    expect(isFailClosed("/workspace", "work")).toBeTrue()
    expect(currentResumeEpoch("/workspace", "work")).toBe(0)
  })

  test("#given promotion A revalidates after promotion B establishes an episode #when A reaches its lock tail #then A observes B's epoch and drops", async () => {
    // given
    const expectedEpoch = currentResumeEpoch("/workspace", "work")
    const established = await runPromotion("/workspace", "work", expectedEpoch, async (control) => {
      await control.advanceEpochAndResume(async () => true)
      return { meta: question, persisted: false }
    })

    // when
    const stale = await runPromotion("/workspace", "work", expectedEpoch, async () => ({
      meta: planBlocked,
      persisted: false,
    }))

    // then
    expect(established).toBeTrue()
    expect(stale).toBeFalse()
    expect(isFailClosed("/workspace", "work")).toBeTrue()
  })

  test("#given stale self-healing advances the epoch while promotion P waits #when P enters the serializer #then P cannot rewrite waiting", async () => {
    // given
    const expectedEpoch = currentResumeEpoch("/workspace", "work")
    await recordHumanResumeAndClear("/workspace", "work")

    // when
    const promoted = await runPromotion("/workspace", "work", expectedEpoch, async () => ({
      meta: planBlocked,
      persisted: true,
    }))

    // then
    expect(promoted).toBeFalse()
    expect(isFailClosed("/workspace", "work")).toBeFalse()
  })
})
