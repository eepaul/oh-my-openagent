import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import * as fs from "node:fs"

import { getWorkForSession } from "../../features/boulder-state"
import { _resetForTesting } from "../../features/claude-code-session-state"
import { releaseAllPromptAsyncReservationsForTesting } from "../shared/prompt-async-gate"
import {
  isFailClosed,
  resetWaitingFailClosedGateForTesting,
} from "../shared/waiting-fail-closed-gate"
import { createTodoContinuationEnforcer } from "."
import {
  CONTINUABLE_MESSAGES,
  createCountdownTimerProbe,
  createWaitingOnHumanFixture,
  createWaitingOnHumanNotifierSpy,
  createWaitingOnHumanPluginInput,
  removeWaitingOnHumanFixture,
  replacePlan,
  type CountdownTimerProbe,
  type SessionMessagesResponse,
  type WaitingOnHumanFixture,
} from "./waiting-on-human-test-fixture.test"

const PENDING_PLAN = "## TODOs\n- [ ] 1. Continue the work\n"
const BLOCKED_PLAN = "## TODOs\n- [~] 1. Await a human decision\n"

const pendingQuestionMessages: SessionMessagesResponse = {
  data: [{
    info: { role: "assistant", finish: true, time: { completed: 1 } },
    parts: [{
      type: "tool",
      tool: "question",
      callID: "call_fail_closed",
      state: { status: "pending" },
    }],
  }],
}

describe("todo continuation waiting-on-human fail-closed gate", () => {
  let timerProbe: CountdownTimerProbe
  const fixtures: WaitingOnHumanFixture[] = []

  beforeEach(() => {
    timerProbe = createCountdownTimerProbe()
    releaseAllPromptAsyncReservationsForTesting()
    resetWaitingFailClosedGateForTesting()
    _resetForTesting()
  })

  afterEach(() => {
    for (const fixture of fixtures.splice(0)) {
      removeWaitingOnHumanFixture(fixture)
    }
    releaseAllPromptAsyncReservationsForTesting()
    resetWaitingFailClosedGateForTesting()
    _resetForTesting()
  })

  test("#given a queued countdown and a plan-blocked write failure #when the countdown fires #then fail-closed suppresses continuation", async () => {
    // given
    const fixture = createWaitingOnHumanFixture({ plan: PENDING_PLAN, sessionID: "ses_plan_write_failure" })
    fixtures.push(fixture)
    const promptCalls: Array<{ readonly sessionID: string; readonly text: string }> = []
    const { notifier } = createWaitingOnHumanNotifierSpy()
    const hook = createTodoContinuationEnforcer(createWaitingOnHumanPluginInput({ fixture, promptCalls }), {
      waitingOnHumanNotifier: notifier,
      countdownScheduler: timerProbe.scheduler,
    })
    await hook.handler({ event: { type: "session.idle", properties: { sessionID: fixture.sessionID } } })
    replacePlan(fixture, BLOCKED_PLAN)
    const work = getWorkForSession(fixture.directory, fixture.sessionID)
    if (work === null) {
      throw new Error("Expected a boulder work bound to the fixture session")
    }
    const writeFileSync = spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw new Error("simulated boulder write failure")
    })

    // when
    try {
      await timerProbe.fireCountdown()
    } finally {
      writeFileSync.mockRestore()
    }

    // then
    expect(isFailClosed(fixture.directory, work.work_id)).toBeTrue()
    expect(promptCalls).toHaveLength(0)
  })

  test("#given a queued countdown and a question-tool write failure #when its pending question is detected #then the countdown fresh-read suppresses continuation", async () => {
    // given
    const fixture = createWaitingOnHumanFixture({ plan: PENDING_PLAN, sessionID: "ses_question_write_failure" })
    fixtures.push(fixture)
    const promptCalls: Array<{ readonly sessionID: string; readonly text: string }> = []
    let messages: SessionMessagesResponse = CONTINUABLE_MESSAGES
    const { notifier } = createWaitingOnHumanNotifierSpy()
    const hook = createTodoContinuationEnforcer(createWaitingOnHumanPluginInput({
      fixture,
      promptCalls,
      messages: async () => messages,
    }), {
      waitingOnHumanNotifier: notifier,
      countdownScheduler: timerProbe.scheduler,
    })
    await hook.handler({ event: { type: "session.idle", properties: { sessionID: fixture.sessionID } } })
    messages = pendingQuestionMessages
    const work = getWorkForSession(fixture.directory, fixture.sessionID)
    if (work === null) {
      throw new Error("Expected a boulder work bound to the fixture session")
    }
    const writeFileSync = spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw new Error("simulated boulder write failure")
    })

    // when
    try {
      await hook.handler({ event: { type: "session.idle", properties: { sessionID: fixture.sessionID } } })
      await timerProbe.fireCountdown()
    } finally {
      writeFileSync.mockRestore()
    }

    // then
    expect(isFailClosed(fixture.directory, work.work_id)).toBeTrue()
    expect(promptCalls).toHaveLength(0)
  })
})
