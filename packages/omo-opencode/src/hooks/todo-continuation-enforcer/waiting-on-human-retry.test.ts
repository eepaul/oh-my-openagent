import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { enterWaitingOnHuman } from "@oh-my-opencode/boulder-state"
import { getWorkForSession } from "../../features/boulder-state"
import { _resetForTesting } from "../../features/claude-code-session-state"
import { releaseAllPromptAsyncReservationsForTesting } from "../shared/prompt-async-gate"
import { resetWaitingFailClosedGateForTesting } from "../shared/waiting-fail-closed-gate"
import { createTodoContinuationEnforcer } from "."
import { injectContinuation } from "./continuation-injection"
import { createSessionStateStore } from "./session-state"
import {
  createCountdownTimerProbe,
  createWaitingOnHumanFixture,
  createWaitingOnHumanNotifierSpy,
  createWaitingOnHumanPluginInput,
  removeWaitingOnHumanFixture,
  type CountdownTimerProbe,
  type WaitingOnHumanFixture,
} from "./waiting-on-human-test-fixture.test"

const PENDING_PLAN = "## TODOs\n- [ ] 1. Continue the work\n"

describe("todo continuation waiting-on-human retry gate", () => {
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

  test("#given a queued countdown whose bound work enters durable question waiting #when the countdown fires #then it fresh-reads and suppresses continuation", async () => {
    // given
    const fixture = createWaitingOnHumanFixture({ plan: PENDING_PLAN, sessionID: "ses_retry_waiting" })
    fixtures.push(fixture)
    const promptCalls: Array<{ readonly sessionID: string; readonly text: string }> = []
    const { notifier, notifications } = createWaitingOnHumanNotifierSpy()
    const hook = createTodoContinuationEnforcer(createWaitingOnHumanPluginInput({ fixture, promptCalls }), {
      waitingOnHumanNotifier: notifier,
      countdownScheduler: timerProbe.scheduler,
    })
    await hook.handler({ event: { type: "session.idle", properties: { sessionID: fixture.sessionID } } })
    const work = getWorkForSession(fixture.directory, fixture.sessionID)
    if (work === null) {
      throw new Error("Expected a boulder work bound to the fixture session")
    }
    expect(enterWaitingOnHuman(fixture.directory, work.work_id, {
      reason: "Awaiting the answer to question call_retry",
      source: "question-tool",
      question_call_id: "call_retry",
    })).toBeTrue()

    // when
    await timerProbe.fireCountdown()

    // then
    expect(promptCalls).toHaveLength(0)
    expect(notifications).toHaveLength(1)
  })

  test("#given bound work is durably waiting before direct injection #when final dispatch is evaluated #then it emits no continuation", async () => {
    // given
    const fixture = createWaitingOnHumanFixture({ plan: PENDING_PLAN, sessionID: "ses_dispatch_waiting" })
    fixtures.push(fixture)
    const promptCalls: Array<{ readonly sessionID: string; readonly text: string }> = []
    const { notifier, notifications } = createWaitingOnHumanNotifierSpy()
    const work = getWorkForSession(fixture.directory, fixture.sessionID)
    if (work === null) {
      throw new Error("Expected a boulder work bound to the fixture session")
    }
    expect(enterWaitingOnHuman(fixture.directory, work.work_id, {
      reason: "Awaiting the answer to question call_dispatch",
      source: "question-tool",
      question_call_id: "call_dispatch",
    })).toBeTrue()

    // when
    await injectContinuation({
      ctx: createWaitingOnHumanPluginInput({ fixture, promptCalls }),
      sessionID: fixture.sessionID,
      resolvedInfo: {
        agent: "Sisyphus",
        model: { providerID: "openai", modelID: "gpt-5.6" },
        tools: { write: "allow" },
      },
      sessionStateStore: createSessionStateStore(timerProbe.scheduler),
      waitingOnHumanNotifier: notifier,
    })

    // then
    expect(promptCalls).toHaveLength(0)
    expect(notifications).toHaveLength(1)
  })
})
