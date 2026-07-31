import { afterEach, describe, expect, test } from "bun:test"

import {
  armFailClosed,
  currentResumeEpoch,
  isFailClosed,
  recordHumanResumeAndClear,
  resetWaitingFailClosedGateForTesting,
  runPromotion,
} from "./waiting-fail-closed-gate"

const planBlocked = { source: "plan-blocked" } as const

describe("waiting fail-closed gate interleavings one through five", () => {
  afterEach(() => {
    resetWaitingFailClosedGateForTesting()
  })

  test("#given question completion is queued before a blocked enter resolves #when both settle #then the later resume clears the episode", async () => {
    // given
    const entered = Promise.withResolvers<void>()
    const releaseEnter = Promise.withResolvers<void>()
    const promotion = runPromotion("/workspace", "work", 0, async () => {
      entered.resolve()
      await releaseEnter.promise
      return { meta: planBlocked, persisted: false }
    })
    await entered.promise

    // when
    const resume = recordHumanResumeAndClear("/workspace", "work")
    releaseEnter.resolve()
    await Promise.all([promotion, resume])

    // then
    expect(isFailClosed("/workspace", "work")).toBeFalse()
    expect(currentResumeEpoch("/workspace", "work")).toBe(1)
  })

  test("#given human input queues while an enter write later fails #when the serializer drains #then late failure cannot re-arm the cleared gate", async () => {
    // given
    const entered = Promise.withResolvers<void>()
    const releaseEnter = Promise.withResolvers<void>()
    const promotion = runPromotion("/workspace", "work", 0, async () => {
      entered.resolve()
      await releaseEnter.promise
      return { meta: planBlocked, persisted: false }
    })
    await entered.promise
    const resume = recordHumanResumeAndClear("/workspace", "work")

    // when
    releaseEnter.resolve()
    await Promise.all([promotion, resume])

    // then
    expect(isFailClosed("/workspace", "work")).toBeFalse()
  })

  test("#given a promotion write is blocked #when a human resume arrives #then serialization leaves the work episode resumable", async () => {
    // given
    const entered = Promise.withResolvers<void>()
    const releaseWrite = Promise.withResolvers<void>()
    const promotion = runPromotion("/workspace", "work", 0, async () => {
      entered.resolve()
      await releaseWrite.promise
      return { meta: planBlocked, persisted: true }
    })
    await entered.promise
    const resume = recordHumanResumeAndClear("/workspace", "work")

    // when
    releaseWrite.resolve()
    await Promise.all([promotion, resume])

    // then
    expect(currentResumeEpoch("/workspace", "work")).toBe(1)
    expect(isFailClosed("/workspace", "work")).toBeFalse()
  })

  test("#given colliding legacy string-concat keys in separate directories #when each gate changes #then their gates and epochs remain isolated", async () => {
    // given
    await armFailClosed("/a", "bc", planBlocked)
    await armFailClosed("/ab", "c", planBlocked)

    // when
    await recordHumanResumeAndClear("/a", "bc")

    // then
    expect(isFailClosed("/a", "bc")).toBeFalse()
    expect(isFailClosed("/ab", "c")).toBeTrue()
    expect(currentResumeEpoch("/a", "bc")).toBe(1)
    expect(currentResumeEpoch("/ab", "c")).toBe(0)
  })

  test("#given an observation captured before human resume #when its promotion enters after the epoch advances #then CAS drops it", async () => {
    // given
    const expectedEpoch = currentResumeEpoch("/workspace", "work")
    await recordHumanResumeAndClear("/workspace", "work")

    // when
    const promoted = await runPromotion("/workspace", "work", expectedEpoch, async () => ({
      meta: planBlocked,
      persisted: false,
    }))

    // then
    expect(promoted).toBeFalse()
    expect(isFailClosed("/workspace", "work")).toBeFalse()
  })
})
