/// <reference path="../../../../../bun-test.d.ts" />

import { describe, expect, it } from "bun:test"

import { createFallbackTimeoutHelpers } from "./auto-retry-timeout"
import { observeEventForWatchdog, type FirstPromptWatchdog } from "./first-prompt-watchdog"
import type { HookDeps } from "./types"

function noopWatchdog(): FirstPromptWatchdog {
  return {
    onUserMessage() {},
    onAssistantProgress() {},
    onSessionTerminal() {},
    dispose() {},
  }
}

describe("observeEventForWatchdog onAssistantActivity", () => {
  const sessionID = "ses_activity"

  it("#given a streaming reasoning delta #when observed #then onAssistantActivity fires with the sessionID", () => {
    // given
    const activity: string[] = []

    // when
    observeEventForWatchdog(
      { type: "session.next.reasoning.delta", properties: { sessionID } },
      noopWatchdog(),
      (id) => activity.push(id),
    )

    // then
    expect(activity).toEqual([sessionID])
  })

  it("#given an assistant message.updated carrying a reasoning part #when observed #then onAssistantActivity fires", () => {
    // given
    const activity: string[] = []

    // when
    observeEventForWatchdog(
      {
        type: "message.updated",
        properties: { info: { sessionID, role: "assistant" }, parts: [{ type: "reasoning" }] },
      },
      noopWatchdog(),
      (id) => activity.push(id),
    )

    // then
    expect(activity).toEqual([sessionID])
  })

  it("#given an assistant message.updated carrying only an error #when observed #then onAssistantActivity does NOT fire so an errored turn never extends the deadline", () => {
    // given
    const activity: string[] = []

    // when
    observeEventForWatchdog(
      {
        type: "message.updated",
        properties: { info: { sessionID, role: "assistant", error: { name: "ProviderError" } }, parts: [] },
      },
      noopWatchdog(),
      (id) => activity.push(id),
    )

    // then
    expect(activity).toEqual([])
  })
})

function createDeps(): HookDeps {
  return {
    ctx: {} as HookDeps["ctx"],
    config: {
      enabled: true,
      retry_on_errors: [429],
      max_fallback_attempts: 3,
      cooldown_seconds: 60,
      timeout_seconds: 300,
      notify_on_fallback: false,
    },
    options: undefined,
    pluginConfig: {},
    sessionStates: new Map(),
    sessionLastAccess: new Map(),
    sessionRetryInFlight: new Set(),
    sessionAwaitingFallbackResult: new Set(),
    sessionFallbackTimeouts: new Map(),
    sessionStatusRetryKeys: new Map(),
    internallyAbortedSessions: new Set(),
  }
}

describe("createFallbackTimeoutHelpers refreshSessionFallbackTimeout (inactivity reset)", () => {
  it("#given an armed fallback deadline #when activity refreshes it #then the deadline is re-armed instead of held to the original wall", () => {
    // given
    const deps = createDeps()
    const { scheduleSessionFallbackTimeout, refreshSessionFallbackTimeout, clearSessionFallbackTimeout } =
      createFallbackTimeoutHelpers(deps, async () => {}, async () => {})
    const sessionID = "ses_thinking"
    scheduleSessionFallbackTimeout(sessionID, "sisyphus")
    const armed = deps.sessionFallbackTimeouts.get(sessionID)

    // when
    refreshSessionFallbackTimeout(sessionID)

    // then
    const reArmed = deps.sessionFallbackTimeouts.get(sessionID)
    expect(reArmed).toBeDefined()
    expect(reArmed).not.toBe(armed)

    clearSessionFallbackTimeout(sessionID)
  })

  it("#given no armed deadline #when refresh is called #then it is a no-op and does not arm a new timer", () => {
    // given
    const deps = createDeps()
    const { refreshSessionFallbackTimeout } = createFallbackTimeoutHelpers(deps, async () => {}, async () => {})

    // when
    refreshSessionFallbackTimeout("ses_idle")

    // then
    expect(deps.sessionFallbackTimeouts.has("ses_idle")).toBe(false)
  })
})
