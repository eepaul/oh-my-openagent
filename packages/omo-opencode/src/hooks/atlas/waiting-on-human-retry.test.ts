import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { scheduleRetry } from "./idle-continuation"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"
import {
  ATLAS_WAITING_SESSION_ID,
  createAtlasSessionState,
  createAtlasWaitingContext,
  createWaitingNotifierSpy,
  writeAtlasBoulder,
} from "./waiting-on-human-test-helpers.test"

type SetTimeoutParameters = Parameters<typeof setTimeout>
type SetTimeoutRestParameters = SetTimeoutParameters extends [
  SetTimeoutParameters[0],
  SetTimeoutParameters[1]?,
  ...infer Rest,
] ? Rest : never

describe("scheduleRetry waiting on human", () => {
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  const timers = new Map<number, { readonly callback: () => void | Promise<void> }>()
  let directory = ""
  let nextTimerID = 1

  beforeEach(() => {
    directory = join(tmpdir(), `atlas-waiting-retry-${randomUUID()}`)
    mkdirSync(directory, { recursive: true })
    timers.clear()
    nextTimerID = 1
    globalThis.setTimeout = Object.assign(
      (
        callback: SetTimeoutParameters[0],
        delay?: SetTimeoutParameters[1],
        ...args: SetTimeoutRestParameters
      ): ReturnType<typeof setTimeout> => {
        if (typeof callback !== "function") {
          return originalSetTimeout(callback, delay, ...args)
        }
        const timerID = nextTimerID
        nextTimerID += 1
        timers.set(timerID, { callback: () => callback(...args) })
        return unsafeTestValue<ReturnType<typeof setTimeout>>(timerID)
      },
      { __promisify__: originalSetTimeout.__promisify__ },
    )
    const fakeClearTimeout = (timerID?: Parameters<typeof clearTimeout>[0]): void => {
      if (typeof timerID === "number") {
        timers.delete(timerID)
        return
      }
      originalClearTimeout(unsafeTestValue<Parameters<typeof originalClearTimeout>[0]>(timerID))
    }
    globalThis.clearTimeout = unsafeTestValue<typeof clearTimeout>(fakeClearTimeout)
  })

  afterEach(() => {
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
    if (existsSync(directory)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("#given twenty-six complete tasks and one blocked task #when a scheduled retry runs #then it notifies instead of silently completing", async () => {
    // given
    const planPath = join(directory, "plan.md")
    const completedTasks = Array.from(
      { length: 26 },
      (_, index) => `- [x] ${index + 1}. Complete task ${index + 1}`,
    )
    writeFileSync(planPath, ["## TODOs", ...completedTasks, "- [~] 27. Await approval", ""].join("\n"))
    writeAtlasBoulder(directory, planPath)
    const { ctx, promptAsync } = createAtlasWaitingContext(directory)
    const { notifier, notifications } = createWaitingNotifierSpy()
    const sessionState = createAtlasSessionState()
    scheduleRetry({
      ctx,
      sessionID: ATLAS_WAITING_SESSION_ID,
      sessionState,
      options: { directory, waitingOnHumanNotifier: notifier },
    })
    const retry = timers.get(1)
    if (!retry) {
      throw new Error("Expected scheduled retry")
    }

    // when
    await retry.callback()

    // then
    expect(notifications).toHaveLength(1)
    expect(notifications[0]?.blockedCount).toBe(1)
    expect(promptAsync).not.toHaveBeenCalled()
  })

  test("#given a retry is queued before the plan becomes blocked #when the retry runs #then it observes waiting at execution time", async () => {
    // given
    const planPath = join(directory, "plan.md")
    writeFileSync(planPath, "## TODOs\n- [ ] 1. Implement change\n")
    writeAtlasBoulder(directory, planPath)
    const { ctx, promptAsync } = createAtlasWaitingContext(directory)
    const { notifier, notifications } = createWaitingNotifierSpy()
    const sessionState = createAtlasSessionState()
    scheduleRetry({
      ctx,
      sessionID: ATLAS_WAITING_SESSION_ID,
      sessionState,
      options: { directory, waitingOnHumanNotifier: notifier },
    })
    const retry = timers.get(1)
    if (!retry) {
      throw new Error("Expected scheduled retry")
    }
    writeFileSync(planPath, "## TODOs\n- [~] 1. Await approval\n")

    // when
    await retry.callback()

    // then
    expect(notifications).toHaveLength(1)
    expect(promptAsync).not.toHaveBeenCalled()
    expect(sessionState.pendingRetryTimer).toBeUndefined()
  })
})
