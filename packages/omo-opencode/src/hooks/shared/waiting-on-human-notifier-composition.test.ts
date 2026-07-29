import { afterEach, describe, expect, test } from "bun:test"

import { releaseAllPromptAsyncReservationsForTesting } from "../../shared/prompt-async-gate"
import { createWaitingOnHumanNotifier } from "./waiting-on-human-notifier"

function createNotification(client: {
  readonly session: { readonly promptAsync: (input: unknown) => Promise<unknown> }
}) {
  return {
    client,
    directory: "/workspace",
    sessionID: "ses_waiting",
    planPath: "/workspace/.omo/plans/plan.md",
    planName: "plan",
    blockedCount: 2,
    preDispatchGuard: () => true,
    settleMs: 0,
  }
}

describe("createWaitingOnHumanNotifier composition", () => {
  afterEach(() => {
    // then
    releaseAllPromptAsyncReservationsForTesting()
  })

  test("#given enforcer then atlas idle handling for one waiting episode #when both notify #then promptAsync runs once with the passive template", async () => {
    // given
    const prompts: unknown[] = []
    const client = {
      session: {
        promptAsync: async (input: unknown) => {
          prompts.push(input)
        },
      },
    }
    const notifier = createWaitingOnHumanNotifier()
    const notification = createNotification(client)

    // when
    await notifier.maybeNotify(notification)
    await notifier.maybeNotify(notification)

    // then
    expect(prompts).toHaveLength(1)
    const prompt = JSON.stringify(prompts[0])
    expect(prompt).toContain("blocked on a human decision")
    expect(prompt).not.toContain("Proceed without asking for permission")
    expect(prompt).not.toContain("Do not stop")
  })

  test("#given a consumed waiting episode #when the semantic dedupe window has elapsed #then its notifier reservation still prevents another prompt", async () => {
    // given
    let promptCalls = 0
    const originalDateNow = Date.now
    let now = originalDateNow()
    Date.now = () => now
    const client = {
      session: {
        promptAsync: async () => {
          promptCalls += 1
        },
      },
    }
    const notifier = createWaitingOnHumanNotifier()
    const notification = createNotification(client)

    try {
      // when
      await notifier.maybeNotify(notification)
      now += 15_001
      await notifier.maybeNotify(notification)

      // then
      expect(promptCalls).toBe(1)
    } finally {
      Date.now = originalDateNow
    }
  })

  test("#given two concurrent notifications for one waiting episode #when the first dispatch is pending #then synchronous reservation permits one prompt", async () => {
    // given
    let promptCalls = 0
    const promptStarted = Promise.withResolvers<void>()
    const finishPrompt = Promise.withResolvers<void>()
    const client = {
      session: {
        promptAsync: async () => {
          promptCalls += 1
          promptStarted.resolve()
          await finishPrompt.promise
        },
      },
    }
    const notifier = createWaitingOnHumanNotifier()
    const notification = createNotification(client)

    // when
    const first = notifier.maybeNotify(notification)
    await promptStarted.promise
    const second = notifier.maybeNotify(notification)
    finishPrompt.resolve()
    await Promise.all([first, second])

    // then
    expect(promptCalls).toBe(1)
  })
})
