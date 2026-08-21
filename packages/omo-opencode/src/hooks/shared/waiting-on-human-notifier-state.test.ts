import { describe, expect, test } from "bun:test"

import { dispatchInternalPrompt } from "../../shared/prompt-async-gate"
import { createWaitingOnHumanNotifier } from "./waiting-on-human-notifier"

const client = {
  session: {
    promptAsync: async (_input: unknown) => undefined,
  },
}

const notification = {
  client,
  directory: "/workspace",
  sessionID: "ses_waiting",
  workId: "work_waiting",
  waitingSince: "2026-07-31T00:00:00.000Z",
  planPath: "/workspace/.omo/plans/plan.md",
  planName: "plan",
  blockedCount: 2,
  shouldDispatch: () => true,
  settleMs: 0,
}

const reservationCases = [
  {
    name: "dispatched",
    result: { status: "dispatched", response: undefined },
    keepsReservation: true,
  },
  {
    name: "queued",
    result: { status: "queued", queuedBy: "test", position: 1 },
    keepsReservation: true,
  },
  {
    name: "ambiguous failed",
    result: { status: "failed", error: new Error("timed out"), dispatchAttempted: true },
    keepsReservation: true,
  },
  {
    name: "active",
    result: { status: "active" },
    keepsReservation: false,
  },
  {
    name: "reserved",
    result: { status: "reserved", reservedBy: "other" },
    keepsReservation: false,
  },
  {
    name: "unavailable",
    result: { status: "unavailable" },
    keepsReservation: false,
  },
  {
    name: "guard rejected",
    result: { status: "cancelled" },
    keepsReservation: false,
  },
  {
    name: "determinate failed",
    result: { status: "failed", error: new Error("permission denied"), dispatchAttempted: false },
    keepsReservation: false,
  },
] satisfies readonly {
  readonly name: string
  readonly result: Awaited<ReturnType<typeof dispatchInternalPrompt>>
  readonly keepsReservation: boolean
}[]

describe("createWaitingOnHumanNotifier reservation state", () => {
  for (const reservationCase of reservationCases) {
    test(`#given ${reservationCase.name} #when the same waiting episode idles again #then the reservation state follows the gate table`, async () => {
      // given
      let dispatches = 0
      const dispatch: typeof dispatchInternalPrompt = async () => {
        dispatches += 1
        return reservationCase.result
      }
      const notifier = createWaitingOnHumanNotifier({ dispatchInternalPrompt: dispatch })

      // when
      await notifier.maybeNotify(notification)
      await notifier.maybeNotify(notification)

      // then
      expect(dispatches).toBe(reservationCase.keepsReservation ? 1 : 2)
    })
  }

  test("#given a consumed waiting episode #when its reason snapshot changes then a new episode begins #then only the new since value or reset permits notification", async () => {
    // given
    let dispatches = 0
    const dispatch: typeof dispatchInternalPrompt = async () => {
      dispatches += 1
      return { status: "dispatched", response: undefined }
    }
    const notifier = createWaitingOnHumanNotifier({ dispatchInternalPrompt: dispatch })

    // when
    await notifier.maybeNotify(notification)
    await notifier.maybeNotify({ ...notification, blockedCount: 3 })
    await notifier.maybeNotify({ ...notification, waitingSince: "2026-07-31T00:01:00.000Z" })
    notifier.reset(notification.sessionID)
    await notifier.maybeNotify(notification)

    // then
    expect(dispatches).toBe(3)
  })

  test("#given temporary fail-closed notification #when the same work later persists its since timestamp #then it does not notify twice", async () => {
    // given
    let dispatches = 0
    const notifier = createWaitingOnHumanNotifier({
      dispatchInternalPrompt: async () => {
        dispatches += 1
        return { status: "dispatched", response: undefined }
      },
    })

    // when
    await notifier.maybeNotify({ ...notification, waitingSince: undefined })
    await notifier.maybeNotify(notification)

    // then
    expect(dispatches).toBe(1)
  })
})
