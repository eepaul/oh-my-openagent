import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { getWorkForSession } from "../../features/boulder-state"
import { _resetForTesting } from "../../features/claude-code-session-state"
import { releaseAllPromptAsyncReservationsForTesting } from "../shared/prompt-async-gate"
import { resetWaitingFailClosedGateForTesting } from "../shared/waiting-fail-closed-gate"
import { createTodoContinuationEnforcer } from "."
import {
  createCountdownTimerProbe,
  createWaitingOnHumanFixture,
  createWaitingOnHumanPluginInput,
  removeWaitingOnHumanFixture,
  type CountdownTimerProbe,
  type SessionMessagesResponse,
  type WaitingOnHumanFixture,
} from "./waiting-on-human-test-fixture.test"

const PENDING_PLAN = "## TODOs\n- [ ] 1. Continue the work\n"
const QUESTION_CALL_ID = "call_waiting_question"

const pendingQuestionMessages: SessionMessagesResponse = {
  data: [{
    info: { role: "assistant", finish: true, time: { completed: 1 } },
    parts: [{
      type: "tool",
      tool: "question",
      callID: QUESTION_CALL_ID,
      state: { status: "pending" },
    }],
  }],
}

const completedQuestionMessages: SessionMessagesResponse = {
  data: [{
    info: { role: "assistant", finish: true, time: { completed: 1 } },
    parts: [{
      type: "tool",
      tool: "question",
      callID: QUESTION_CALL_ID,
      state: { status: "completed" },
    }],
  }],
}

describe("todo continuation question-tool waiting promotion", () => {
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

  test("#given a bound work and a stable pending question call #when it idles #then question-tool waiting is persisted before any continuation", async () => {
    // given
    const fixture = createWaitingOnHumanFixture({ plan: PENDING_PLAN, sessionID: "ses_question_promoted" })
    fixtures.push(fixture)
    const promptCalls: Array<{ readonly sessionID: string; readonly text: string }> = []
    const hook = createTodoContinuationEnforcer(createWaitingOnHumanPluginInput({
      fixture,
      promptCalls,
      messages: async () => pendingQuestionMessages,
    }), {
      countdownScheduler: timerProbe.scheduler,
    })

    // when
    await hook.handler({ event: { type: "session.idle", properties: { sessionID: fixture.sessionID } } })

    // then
    const work = getWorkForSession(fixture.directory, fixture.sessionID)
    expect(work?.status).toBe("waiting_on_human")
    expect(work?.waiting?.source).toBe("question-tool")
    expect(work?.waiting?.question_call_id).toBe(QUESTION_CALL_ID)
    expect(timerProbe.countdownStarts()).toBe(0)
    expect(promptCalls).toHaveLength(0)
  })

  test("#given question completion wins before promotion confirmation #when idle handles the stale detection #then the match-aware close allows the queued continuation", async () => {
    // given
    const fixture = createWaitingOnHumanFixture({ plan: PENDING_PLAN, sessionID: "ses_question_completed_before_arm" })
    fixtures.push(fixture)
    const promptCalls: Array<{ readonly sessionID: string; readonly text: string }> = []
    const confirmationRequested = Promise.withResolvers<void>()
    const confirmation = Promise.withResolvers<SessionMessagesResponse>()
    let messageReads = 0
    const hook = createTodoContinuationEnforcer(createWaitingOnHumanPluginInput({
      fixture,
      promptCalls,
      messages: async () => {
        messageReads += 1
        if (messageReads === 1) {
          return pendingQuestionMessages
        }
        if (messageReads === 2) {
          confirmationRequested.resolve()
          return confirmation.promise
        }
        return completedQuestionMessages
      },
    }), {
      countdownScheduler: timerProbe.scheduler,
    })

    // when
    const idle = hook.handler({ event: { type: "session.idle", properties: { sessionID: fixture.sessionID } } })
    await confirmationRequested.promise
    confirmation.resolve(completedQuestionMessages)
    await idle

    // then
    expect(getWorkForSession(fixture.directory, fixture.sessionID)?.status).toBe("active")
    expect(timerProbe.countdownStarts()).toBe(1)
    await timerProbe.fireCountdown()
    expect(promptCalls).toHaveLength(1)
  })

  test("#given question completion races a blocked promotion confirmation #when the serializer finishes #then it immediately resumes the work", async () => {
    // given
    const fixture = createWaitingOnHumanFixture({ plan: PENDING_PLAN, sessionID: "ses_question_completed_during_write" })
    fixtures.push(fixture)
    const promptCalls: Array<{ readonly sessionID: string; readonly text: string }> = []
    const confirmationRequested = Promise.withResolvers<void>()
    const confirmation = Promise.withResolvers<SessionMessagesResponse>()
    let messageReads = 0
    const hook = createTodoContinuationEnforcer(createWaitingOnHumanPluginInput({
      fixture,
      promptCalls,
      messages: async () => {
        messageReads += 1
        if (messageReads === 1) {
          return pendingQuestionMessages
        }
        if (messageReads === 2) {
          confirmationRequested.resolve()
          return confirmation.promise
        }
        return completedQuestionMessages
      },
    }), {
      countdownScheduler: timerProbe.scheduler,
    })

    // when
    const idle = hook.handler({ event: { type: "session.idle", properties: { sessionID: fixture.sessionID } } })
    await confirmationRequested.promise
    confirmation.resolve(pendingQuestionMessages)
    await idle

    // then
    expect(getWorkForSession(fixture.directory, fixture.sessionID)?.status).toBe("active")
    expect(timerProbe.countdownStarts()).toBe(1)
    expect(promptCalls).toHaveLength(0)
  })
})
