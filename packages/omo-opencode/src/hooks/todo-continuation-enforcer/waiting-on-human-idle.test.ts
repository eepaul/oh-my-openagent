import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { _resetForTesting } from "../../features/claude-code-session-state"
import { releaseAllPromptAsyncReservationsForTesting } from "../shared/prompt-async-gate"
import { createTodoContinuationEnforcer } from "."
import {
  createCountdownTimerProbe,
  createWaitingOnHumanFixture,
  createWaitingOnHumanNotifierSpy,
  createWaitingOnHumanPluginInput,
  removeWaitingOnHumanFixture,
  replacePlan,
  type CountdownTimerProbe,
  type WaitingOnHumanFixture,
} from "./waiting-on-human-test-fixture.test"

const BLOCKED_PLAN = "## TODOs\n- [~] 1. Await a human decision\n"
const PENDING_PLAN = "## TODOs\n- [ ] 1. Resume work\n"

describe("todo continuation waiting-on-human idle gate", () => {
  let timerProbe: CountdownTimerProbe
  const fixtures: WaitingOnHumanFixture[] = []

  beforeEach(() => {
    timerProbe = createCountdownTimerProbe()
    releaseAllPromptAsyncReservationsForTesting()
    _resetForTesting()
  })

  afterEach(() => {
    for (const fixture of fixtures.splice(0)) {
      removeWaitingOnHumanFixture(fixture)
    }
    releaseAllPromptAsyncReservationsForTesting()
    _resetForTesting()
  })

  test("#given a bound all-blocked plan and incomplete session todos #when the session idles #then the plan intentionally overrides todos with one passive notification", async () => {
    // given
    const fixture = createWaitingOnHumanFixture({ plan: BLOCKED_PLAN, sessionID: "ses_waiting_idle" })
    fixtures.push(fixture)
    const promptCalls: Array<{ readonly sessionID: string; readonly text: string }> = []
    const { notifier, notifications } = createWaitingOnHumanNotifierSpy()
    const hook = createTodoContinuationEnforcer(createWaitingOnHumanPluginInput({ fixture, promptCalls }), {
      waitingOnHumanNotifier: notifier,
      countdownScheduler: timerProbe.scheduler,
    })

    // when
    await hook.handler({ event: { type: "session.idle", properties: { sessionID: fixture.sessionID } } })

    // then: plan-over-todos is deliberate, matching the final-wave gate's precedence.
    expect(timerProbe.countdownStarts()).toBe(0)
    expect(promptCalls).toHaveLength(0)
    expect(notifications).toHaveLength(1)
  })

  test("#given a stopped session with a bound all-blocked plan #when it idles #then it emits neither forced nor passive prompts", async () => {
    // given
    const fixture = createWaitingOnHumanFixture({ plan: BLOCKED_PLAN, sessionID: "ses_waiting_stopped" })
    fixtures.push(fixture)
    const promptCalls: Array<{ readonly sessionID: string; readonly text: string }> = []
    const { notifier, notifications } = createWaitingOnHumanNotifierSpy()
    const hook = createTodoContinuationEnforcer(createWaitingOnHumanPluginInput({ fixture, promptCalls }), {
      isContinuationStopped: () => true,
      waitingOnHumanNotifier: notifier,
      countdownScheduler: timerProbe.scheduler,
    })

    // when
    await hook.handler({ event: { type: "session.idle", properties: { sessionID: fixture.sessionID } } })

    // then
    expect(timerProbe.countdownStarts()).toBe(0)
    expect(promptCalls).toHaveLength(0)
    expect(notifications).toHaveLength(0)
  })

  test("#given a session without boulder work and incomplete todos #when it idles #then the existing countdown and continuation dispatch remain unchanged", async () => {
    // given
    const fixture = createWaitingOnHumanFixture({
      plan: PENDING_PLAN,
      sessionID: "ses_without_boulder",
      bindBoulder: false,
    })
    fixtures.push(fixture)
    const promptCalls: Array<{ readonly sessionID: string; readonly text: string }> = []
    const { notifier, notifications } = createWaitingOnHumanNotifierSpy()
    const hook = createTodoContinuationEnforcer(createWaitingOnHumanPluginInput({ fixture, promptCalls }), {
      waitingOnHumanNotifier: notifier,
      countdownScheduler: timerProbe.scheduler,
    })

    // when
    await hook.handler({ event: { type: "session.idle", properties: { sessionID: fixture.sessionID } } })
    await timerProbe.fireCountdown()

    // then
    expect(promptCalls).toHaveLength(1)
    expect(notifications).toHaveLength(0)
  })

  test("#given a blocked plan becomes pending #when the session idles again #then countdown and continuation resume", async () => {
    // given
    const fixture = createWaitingOnHumanFixture({ plan: BLOCKED_PLAN, sessionID: "ses_waiting_resumed" })
    fixtures.push(fixture)
    const promptCalls: Array<{ readonly sessionID: string; readonly text: string }> = []
    const { notifier, notifications, resetSessionIDs } = createWaitingOnHumanNotifierSpy()
    const hook = createTodoContinuationEnforcer(createWaitingOnHumanPluginInput({ fixture, promptCalls }), {
      waitingOnHumanNotifier: notifier,
      countdownScheduler: timerProbe.scheduler,
    })
    await hook.handler({ event: { type: "session.idle", properties: { sessionID: fixture.sessionID } } })
    replacePlan(fixture, PENDING_PLAN)

    // when
    await hook.handler({ event: { type: "session.idle", properties: { sessionID: fixture.sessionID } } })
    await timerProbe.fireCountdown()

    // then
    expect(notifications).toHaveLength(1)
    expect(resetSessionIDs).toEqual([fixture.sessionID])
    expect(promptCalls).toHaveLength(1)
  })
})
