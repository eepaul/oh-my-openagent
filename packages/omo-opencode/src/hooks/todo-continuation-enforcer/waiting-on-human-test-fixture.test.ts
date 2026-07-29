import type { PluginInput } from "@opencode-ai/plugin"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createBoulderState, writeBoulderState } from "../../features/boulder-state"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"
import { COUNTDOWN_SECONDS } from "./constants"
import type { CountdownScheduler, CountdownTimerHandle, Todo } from "./types"
import type {
  WaitingOnHumanNotificationInput,
  WaitingOnHumanNotifier,
} from "../shared/waiting-on-human-notifier"

export type PromptCall = {
  readonly sessionID: string
  readonly text: string
}

export type SessionMessagesResponse = { readonly data: readonly unknown[] }

export const CONTINUABLE_MESSAGES: SessionMessagesResponse = {
  data: [{
    info: {
      id: "msg-continuable",
      role: "assistant",
      agent: "Sisyphus",
      finish: true,
      model: { providerID: "openai", modelID: "gpt-5.6" },
      tools: { write: "allow" },
      time: { completed: 1 },
    },
    parts: [],
  }],
}

export type WaitingOnHumanFixture = {
  readonly directory: string
  readonly planPath: string
  readonly sessionID: string
}

type PromptInput = {
  readonly path: { readonly id: string }
  readonly body: { readonly parts: readonly { readonly text: string }[] }
}

export function createWaitingOnHumanFixture(input: {
  readonly plan: string
  readonly sessionID: string
  readonly bindBoulder?: boolean
}): WaitingOnHumanFixture {
  const directory = join(tmpdir(), `enforcer-waiting-${randomUUID()}`)
  mkdirSync(directory, { recursive: true })
  const planPath = join(directory, "plan.md")
  writeFileSync(planPath, input.plan)
  if (input.bindBoulder !== false) {
    writeBoulderState(directory, createBoulderState(planPath, input.sessionID, "sisyphus"))
  }

  return { directory, planPath, sessionID: input.sessionID }
}

export function removeWaitingOnHumanFixture(fixture: WaitingOnHumanFixture): void {
  if (existsSync(fixture.directory)) {
    rmSync(fixture.directory, { recursive: true, force: true })
  }
}

export function replacePlan(fixture: WaitingOnHumanFixture, plan: string): void {
  writeFileSync(fixture.planPath, plan)
}

export function createWaitingOnHumanPluginInput(input: {
  readonly fixture: WaitingOnHumanFixture
  readonly promptCalls: PromptCall[]
  readonly messages?: () => Promise<SessionMessagesResponse>
}): PluginInput {
  let defaultMessageReads = 0
  const messages = async (): Promise<SessionMessagesResponse> => {
    const response = input.messages
      ? await input.messages()
      : (() => {
          defaultMessageReads += 1
          return defaultMessageReads === 2 ? CONTINUABLE_MESSAGES : { data: [] }
        })()
    return response
  }
  const todos: readonly Todo[] = [
    { id: "todo-1", content: "Finish the work", status: "pending", priority: "high" },
  ]

  return unsafeTestValue<PluginInput>({
    directory: input.fixture.directory,
    client: {
      tui: { showToast: async () => ({ data: true }) },
      session: {
        todo: async () => ({ data: todos }),
        messages,
        status: async () => ({ data: { [input.fixture.sessionID]: { type: "idle" } } }),
        promptAsync: async (prompt: PromptInput) => {
          input.promptCalls.push({
            sessionID: prompt.path.id,
            text: prompt.body.parts[0]?.text ?? "",
          })
          return {}
        },
      },
    },
  })
}

export function createWaitingOnHumanNotifierSpy(): {
  readonly notifier: WaitingOnHumanNotifier
  readonly notifications: WaitingOnHumanNotificationInput[]
  readonly resetSessionIDs: string[]
} {
  const notifications: WaitingOnHumanNotificationInput[] = []
  const resetSessionIDs: string[] = []
  const notifier = {
    maybeNotify: async (notification: WaitingOnHumanNotificationInput) => {
      notifications.push(notification)
      return null
    },
    reset: (sessionID: string) => {
      resetSessionIDs.push(sessionID)
    },
  } satisfies WaitingOnHumanNotifier

  return { notifier, notifications, resetSessionIDs }
}

type CountdownTimer = {
  readonly callback: () => unknown
  readonly delay: number | undefined
}

export type CountdownTimerProbe = {
  readonly scheduler: CountdownScheduler
  readonly countdownStarts: () => number
  readonly fireCountdown: () => Promise<void>
}

export function createCountdownTimerProbe(): CountdownTimerProbe {
  const timers = new Map<number, CountdownTimer>()
  let nextTimerID = 1

  const scheduler = {
    setTimeout: (callback: () => void, delay: number): CountdownTimerHandle => {
      const timerID = nextTimerID++
      timers.set(timerID, { callback, delay })
      return { cancel: () => timers.delete(timerID) }
    },
    clearTimeout: (timer: CountdownTimerHandle): void => {
      timer.cancel()
    },
    setInterval: (): CountdownTimerHandle => ({ cancel: () => {} }),
    clearInterval: (timer: CountdownTimerHandle): void => {
      timer.cancel()
    },
  } satisfies CountdownScheduler

  const getCountdownTimers = (): Array<readonly [number, CountdownTimer]> =>
    [...timers.entries()].filter(([, timer]) => timer.delay === COUNTDOWN_SECONDS * 1000)

  return {
    scheduler,
    countdownStarts: () => getCountdownTimers().length,
    fireCountdown: async () => {
      const countdownTimer = getCountdownTimers()[0]
      if (countdownTimer === undefined) {
        throw new Error("Expected a countdown timer")
      }
      const [timerID, timer] = countdownTimer
      timers.delete(timerID)
      await timer.callback()
    },
  }
}
