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
  type SessionMessagesResponse,
  type WaitingOnHumanFixture,
} from "./waiting-on-human-test-fixture.test"

const BLOCKED_PLAN = "## TODOs\n- [~] 1. Await a human decision\n"
const PENDING_PLAN = "## TODOs\n- [ ] 1. Continue the work\n"

describe("todo continuation waiting-on-human countdown gate", () => {
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

  test("#given a normal countdown whose bound plan becomes blocked #when it expires #then it suppresses force and transfers one notification", async () => {
    // given
    const fixture = createWaitingOnHumanFixture({ plan: PENDING_PLAN, sessionID: "ses_countdown_blocked" })
    fixtures.push(fixture)
    const promptCalls: Array<{ readonly sessionID: string; readonly text: string }> = []
    const { notifier, notifications } = createWaitingOnHumanNotifierSpy()
    const hook = createTodoContinuationEnforcer(createWaitingOnHumanPluginInput({ fixture, promptCalls }), {
      waitingOnHumanNotifier: notifier,
      countdownScheduler: timerProbe.scheduler,
    })
    await hook.handler({ event: { type: "session.idle", properties: { sessionID: fixture.sessionID } } })
    replacePlan(fixture, BLOCKED_PLAN)

    // when
    await timerProbe.fireCountdown()

    // then
    expect(promptCalls).toHaveLength(0)
    expect(notifications).toHaveLength(1)
  })

  test("#given stop arrives while the prompt gate awaits messages #when the countdown injection resumes #then cancellation and the final guard prevent every prompt", async () => {
    // given
    const fixture = createWaitingOnHumanFixture({ plan: PENDING_PLAN, sessionID: "ses_countdown_stop_race" })
    fixtures.push(fixture)
    const promptCalls: Array<{ readonly sessionID: string; readonly text: string }> = []
    const messagesRequested = Promise.withResolvers<void>()
    const gateMessages = Promise.withResolvers<SessionMessagesResponse>()
    let messageReads = 0
    let stopped = false
    const { notifier, notifications } = createWaitingOnHumanNotifierSpy()
    const hook = createTodoContinuationEnforcer(createWaitingOnHumanPluginInput({
      fixture,
      promptCalls,
      messages: async () => {
        messageReads += 1
        if (messageReads === 1) {
          return { data: [] }
        }
        messagesRequested.resolve()
        return gateMessages.promise
      },
    }), {
      isContinuationStopped: () => stopped,
      waitingOnHumanNotifier: notifier,
      countdownScheduler: timerProbe.scheduler,
    })
    await hook.handler({ event: { type: "session.idle", properties: { sessionID: fixture.sessionID } } })

    // when
    const countdownInjection = timerProbe.fireCountdown()
    await messagesRequested.promise
    stopped = true
    hook.cancelAllCountdowns()
    gateMessages.resolve({ data: [] })
    await countdownInjection

    // then
    expect(promptCalls).toHaveLength(0)
    expect(notifications).toHaveLength(0)
  }, 30_000)
})
