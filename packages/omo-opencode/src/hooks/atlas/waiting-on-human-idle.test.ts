import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readBoulderState } from "../../features/boulder-state"
import { _resetForTesting, registerAgentName } from "../../features/claude-code-session-state"
import { releaseAllPromptAsyncReservationsForTesting } from "../shared/prompt-async-gate"
import { handleAtlasSessionIdle } from "./idle-event"
import {
  ATLAS_WAITING_SESSION_ID,
  createAtlasSessionState,
  createAtlasWaitingContext,
  createWaitingNotifierSpy,
  writeAtlasBoulder,
} from "./waiting-on-human-test-helpers.test"

describe("handleAtlasSessionIdle waiting on human", () => {
  let directory = ""

  beforeEach(() => {
    directory = join(tmpdir(), `atlas-waiting-idle-${randomUUID()}`)
    mkdirSync(directory, { recursive: true })
    _resetForTesting()
    registerAgentName("atlas")
  })

  afterEach(() => {
    if (existsSync(directory)) {
      rmSync(directory, { recursive: true, force: true })
    }
    _resetForTesting()
    releaseAllPromptAsyncReservationsForTesting()
  })

  test("#given every plan task is blocked #when atlas idles #then it persists waiting without completing or forcing continuation", async () => {
    // given
    const planPath = join(directory, "plan.md")
    writeFileSync(planPath, "## TODOs\n- [~] 1. Await approval\n- [~] 2. Await credentials\n")
    writeAtlasBoulder(directory, planPath)
    const { ctx, promptAsync } = createAtlasWaitingContext(directory)
    const { notifier, notifications } = createWaitingNotifierSpy()
    const state = createAtlasSessionState()

    // when
    await handleAtlasSessionIdle({
      ctx,
      sessionID: ATLAS_WAITING_SESSION_ID,
      getState: () => state,
      options: { directory, idleSettleMs: 0, waitingOnHumanNotifier: notifier },
    })

    // then
    expect(notifications).toHaveLength(1)
    expect(notifications[0]?.blockedCount).toBe(2)
    expect(promptAsync).not.toHaveBeenCalled()
    expect(readBoulderState(directory)?.status).toBe("waiting_on_human")
    expect(readBoulderState(directory)?.waiting?.source).toBe("plan-blocked")
  })

  test("#given twenty-six complete tasks and one blocked task #when atlas idles #then it takes the waiting branch before completion", async () => {
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
    const state = createAtlasSessionState()

    // when
    await handleAtlasSessionIdle({
      ctx,
      sessionID: ATLAS_WAITING_SESSION_ID,
      getState: () => state,
      options: { directory, idleSettleMs: 0, waitingOnHumanNotifier: notifier },
    })

    // then
    expect(notifications).toHaveLength(1)
    expect(notifications[0]?.blockedCount).toBe(1)
    expect(promptAsync).not.toHaveBeenCalled()
    expect(readBoulderState(directory)?.status).toBe("waiting_on_human")
  })

  test("#given a stopped session with only blocked work #when atlas idles #then it sends neither reminder nor continuation", async () => {
    // given
    const planPath = join(directory, "plan.md")
    writeFileSync(planPath, "## TODOs\n- [~] 1. Await approval\n")
    writeAtlasBoulder(directory, planPath)
    const { ctx, promptAsync } = createAtlasWaitingContext(directory)
    const { notifier, notifications } = createWaitingNotifierSpy()
    const state = createAtlasSessionState()

    // when
    await handleAtlasSessionIdle({
      ctx,
      sessionID: ATLAS_WAITING_SESSION_ID,
      getState: () => state,
      options: {
        directory,
        idleSettleMs: 0,
        isContinuationStopped: () => true,
        waitingOnHumanNotifier: notifier,
      },
    })

    // then
    expect(notifications).toHaveLength(0)
    expect(promptAsync).not.toHaveBeenCalled()
  })

  test("#given waiting work becomes pending #when atlas idles again #then it resets the episode and resumes continuation", async () => {
    // given
    const planPath = join(directory, "plan.md")
    writeFileSync(planPath, "## TODOs\n- [~] 1. Await approval\n")
    writeAtlasBoulder(directory, planPath)
    const { ctx, promptAsync } = createAtlasWaitingContext(directory)
    const { notifier, notifications, resetCalls } = createWaitingNotifierSpy()
    const state = createAtlasSessionState()
    const options = { directory, idleSettleMs: 0, waitingOnHumanNotifier: notifier }

    await handleAtlasSessionIdle({
      ctx,
      sessionID: ATLAS_WAITING_SESSION_ID,
      getState: () => state,
      options,
    })
    writeFileSync(planPath, "## TODOs\n- [ ] 1. Resume implementation\n")

    // when
    await handleAtlasSessionIdle({
      ctx,
      sessionID: ATLAS_WAITING_SESSION_ID,
      getState: () => state,
      options,
    })

    // then
    expect(notifications).toHaveLength(1)
    expect(resetCalls()).toBeGreaterThan(0)
    expect(promptAsync).toHaveBeenCalledTimes(1)
    expect(state.lastContinuationInjectedAt).toBeNumber()
  })
})
