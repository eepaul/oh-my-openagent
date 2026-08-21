import { describe, expect, test } from "bun:test"

import { createChatMessageHandler } from "./chat-message-handler"
import { createFallbackState } from "./fallback-state"
import type { HookDeps } from "./types"

function createDeps(): HookDeps {
  return {
    ctx: {
      client: {
        session: {
          abort: async () => ({}),
          messages: async () => ({ data: [] }),
          promptAsync: async () => ({}),
        },
        tui: {
          showToast: async () => ({}),
        },
      },
      directory: "/test/dir",
    },
    config: {
      enabled: true,
      retry_on_errors: [429, 503, 529],
      max_fallback_attempts: 3,
      cooldown_seconds: 0,
      timeout_seconds: 30,
      notify_on_fallback: true,
      restore_primary_after_cooldown: false,
    },
    options: undefined,
    pluginConfig: undefined,
    sessionStates: new Map(),
    sessionLastAccess: new Map(),
    sessionRetryInFlight: new Set(),
    sessionAwaitingFallbackResult: new Set(),
    sessionFallbackTimeouts: new Map(),
    sessionStatusRetryKeys: new Map(),
    internallyAbortedSessions: new Set(),
  }
}

describe("createChatMessageHandler runtime fallback model override", () => {
  test("#given retained retry status keys #when the user selects another model #then the reset starts a fresh retry generation", async () => {
    // given
    const deps = createDeps()
    const sessionID = "session-manual-model-reset"
    const state = createFallbackState("openai/gpt-5.4")
    state.currentModel = "google/gemini-2.5-pro"
    deps.sessionStates.set(sessionID, state)
    deps.sessionStatusRetryKeys.set(sessionID, new Set(["openai/gpt-5.4:1:quota exceeded"]))
    const handler = createChatMessageHandler(deps)

    // when
    await handler(
      {
        sessionID,
        model: {
          providerID: "anthropic",
          modelID: "claude-opus-4-7",
        },
      },
      { message: {} },
    )

    // then
    expect(deps.sessionStatusRetryKeys.has(sessionID)).toBe(false)
    expect(deps.sessionStates.get(sessionID)?.currentModel).toBe("anthropic/claude-opus-4-7")
  })

  test("#given retained variant retry keys #when the user changes only the variant #then the reset starts a fresh retry generation", async () => {
    // given
    const deps = createDeps()
    const sessionID = "session-manual-variant-reset"
    const state = createFallbackState({
      providerID: "openai",
      modelID: "gpt-5.4",
      variant: "high",
    })
    deps.sessionStates.set(sessionID, state)
    deps.sessionStatusRetryKeys.set(sessionID, new Set(["openai/gpt-5.4(low):1:quota exceeded"]))
    deps.sessionRetryInFlight.add(sessionID)
    deps.sessionAwaitingFallbackResult.add(sessionID)
    const fallbackTimeout = setTimeout(() => {}, 60_000)
    fallbackTimeout.unref()
    deps.sessionFallbackTimeouts.set(sessionID, fallbackTimeout)
    const handler = createChatMessageHandler(deps)

    // when
    await handler(
      {
        sessionID,
        model: {
          providerID: "openai",
          modelID: "gpt-5.4",
        },
      },
      { message: { variant: "low" } },
    )

    // then
    expect(deps.sessionStatusRetryKeys.has(sessionID)).toBe(false)
    expect(deps.sessionRetryInFlight.has(sessionID)).toBe(false)
    expect(deps.sessionAwaitingFallbackResult.has(sessionID)).toBe(false)
    expect(deps.sessionFallbackTimeouts.has(sessionID)).toBe(false)
    expect(deps.sessionStates.get(sessionID)?.currentModel).toBe("openai/gpt-5.4(low)")
  })

  test("#given session is on an accepted fallback #when a later user message is transformed after cooldown #then it stays on the fallback model", async () => {
    // given
    const deps = createDeps()
    const sessionID = "session-active-fallback"
    const state = createFallbackState("openai/gpt-5.4")
    state.currentModel = "litellm/openai.eu.gpt-5.5"
    state.fallbackIndex = 0
    state.failedModels.set("openai/gpt-5.4", Date.now() - 60_000)
    deps.sessionStates.set(sessionID, state)
    const handler = createChatMessageHandler(deps)
    const output: { message: { model?: { providerID: string; modelID: string } } } = { message: {} }

    // when
    await handler(
      {
        sessionID,
        model: {
          providerID: "litellm",
          modelID: "openai.eu.gpt-5.5",
        },
      },
      output,
    )

    // then
    expect(output.message.model).toEqual({
      providerID: "litellm",
      modelID: "openai.eu.gpt-5.5",
    })
    expect(deps.sessionStates.get(sessionID)?.currentModel).toBe("litellm/openai.eu.gpt-5.5")
  })

  test("#given an accepted variant fallback #when the fallback override is reapplied #then model and variant remain separate", async () => {
    // given
    const deps = createDeps()
    const sessionID = "session-active-variant-fallback"
    const state = createFallbackState("anthropic/claude-opus-4-7")
    state.currentModel = "openai/gpt-5.4(high)"
    state.fallbackIndex = 0
    deps.sessionStates.set(sessionID, state)
    const handler = createChatMessageHandler(deps)
    const output: {
      message: {
        model?: { providerID: string; modelID: string }
        variant?: string
      }
    } = { message: { variant: "high" } }

    // when
    await handler(
      {
        sessionID,
        model: {
          providerID: "openai",
          modelID: "gpt-5.4",
        },
      },
      output,
    )

    // then
    expect(output.message).toEqual({
      model: {
        providerID: "openai",
        modelID: "gpt-5.4",
      },
      variant: "high",
    })
  })

  test("#given an explicit-variant fallback and a base primary #when cooldown restoration runs #then the fallback-only variant is removed", async () => {
    // given
    const deps = createDeps()
    deps.config.restore_primary_after_cooldown = true
    const sessionID = "session-clear-fallback-only-variant"
    const state = createFallbackState("openai/gpt-5.4")
    state.currentModel = "anthropic/claude-opus-4-7(high)"
    state.fallbackIndex = 0
    deps.sessionStates.set(sessionID, state)
    const handler = createChatMessageHandler(deps)
    const output: {
      message: {
        model?: { providerID: string; modelID: string }
        variant?: string
      }
    } = { message: { variant: "high" } }

    // when
    await handler(
      {
        sessionID,
        model: {
          providerID: "anthropic",
          modelID: "claude-opus-4-7",
        },
      },
      output,
    )

    // then
    expect(output.message).toEqual({
      model: {
        providerID: "openai",
        modelID: "gpt-5.4",
      },
    })
  })

  test("#given an inherited primary variant #when cooldown restoration runs #then the inherited variant remains applied", async () => {
    // given
    const deps = createDeps()
    deps.config.restore_primary_after_cooldown = true
    deps.pluginConfig = {
      agents: {
        sisyphus: {
          variant: "high",
        },
      },
    }
    const sessionID = "session-restore-inherited-primary-variant"
    const state = createFallbackState("openai/gpt-5.4")
    state.currentModel = "anthropic/claude-opus-4-7(high)"
    state.fallbackIndex = 0
    deps.sessionStates.set(sessionID, state)
    const handler = createChatMessageHandler(deps)
    const output: {
      message: {
        model?: { providerID: string; modelID: string }
        variant?: string
      }
    } = { message: { variant: "high" } }

    // when
    await handler(
      {
        sessionID,
        agent: "sisyphus",
        model: {
          providerID: "anthropic",
          modelID: "claude-opus-4-7",
        },
      },
      output,
    )

    // then
    expect(output.message).toEqual({
      model: {
        providerID: "openai",
        modelID: "gpt-5.4",
      },
      variant: "high",
    })
  })
})

describe("createChatMessageHandler variant-normalized fallback state", () => {
  test("#given pending fallback model has a variant #when OpenCode reports the same provider model without variant #then state is not reset", async () => {
    // given
    const deps = createDeps()
    const sessionID = "session-variant-normalized-fallback"
    const state = createFallbackState("anthropic/claude-fable-5")
    state.currentModel = "anthropic/claude-opus-4-8(max)"
    state.pendingFallbackModel = "anthropic/claude-opus-4-8(max)"
    state.fallbackIndex = 0
    state.attemptCount = 1
    deps.sessionStates.set(sessionID, state)
    const handler = createChatMessageHandler(deps)
    const output: { message: { model?: { providerID: string; modelID: string } } } = { message: {} }

    // when
    await handler(
      {
        sessionID,
        model: {
          providerID: "anthropic",
          modelID: "claude-opus-4-8",
        },
      },
      output,
    )

    // then
    const preserved = deps.sessionStates.get(sessionID)
    expect(preserved?.originalModel).toBe("anthropic/claude-fable-5")
    expect(preserved?.currentModel).toBe("anthropic/claude-opus-4-8(max)")
    expect(preserved?.fallbackIndex).toBe(0)
    expect(preserved?.attemptCount).toBe(1)
    expect(preserved?.pendingFallbackModel).toBe(undefined)
    expect(output.message.model).toBeUndefined()
  })
})

describe("createChatMessageHandler separates variant from applied model override", () => {
  test("#given currentModel carries a parenthesized variant #when the fallback override is applied #then modelID is clean and the variant is preserved", async () => {
    // given
    const deps = createDeps()
    const sessionID = "session-fallback-variant-strip"
    const state = createFallbackState("anthropic/claude-opus-4-8")
    state.currentModel = "openai/gpt-5.6-sol(medium)"
    state.fallbackIndex = 0
    deps.sessionStates.set(sessionID, state)
    const handler = createChatMessageHandler(deps)
    const output: { message: { model?: { providerID: string; modelID: string }; variant?: string } } = { message: {} }

    // when
    await handler({ sessionID }, output)

    // then
    expect(output.message.model).toEqual({ providerID: "openai", modelID: "gpt-5.6-sol" })
    expect(output.message.variant).toBe("medium")
  })

  test("#given originalModel carries a parenthesized variant #when the primary model is restored after cooldown #then modelID is clean and the variant is preserved", async () => {
    // given
    const deps = createDeps()
    deps.config.restore_primary_after_cooldown = true
    const sessionID = "session-restore-variant-strip"
    const state = createFallbackState("anthropic/claude-opus-4-8(max)")
    state.currentModel = "openai/gpt-5.6-sol"
    state.fallbackIndex = 0
    deps.sessionStates.set(sessionID, state)
    const handler = createChatMessageHandler(deps)
    const output: { message: { model?: { providerID: string; modelID: string }; variant?: string } } = { message: {} }

    // when
    await handler({ sessionID }, output)

    // then
    expect(output.message.model).toEqual({ providerID: "anthropic", modelID: "claude-opus-4-8" })
    expect(output.message.variant).toBe("max")
  })

  test("#given a fallback model id that itself contains slashes plus a variant #when the override is applied #then only the trailing variant is split off", async () => {
    // given
    const deps = createDeps()
    const sessionID = "session-multislash-variant"
    const state = createFallbackState("anthropic/claude-opus-4-8")
    state.currentModel = "openrouter/deepseek/deepseek-v3.2(medium)"
    state.fallbackIndex = 0
    deps.sessionStates.set(sessionID, state)
    const handler = createChatMessageHandler(deps)
    const output: { message: { model?: { providerID: string; modelID: string }; variant?: string } } = { message: {} }

    // when
    await handler({ sessionID }, output)

    // then
    expect(output.message.model).toEqual({ providerID: "openrouter", modelID: "deepseek/deepseek-v3.2" })
    expect(output.message.variant).toBe("medium")
  })

  test("#given a fallback model with no variant #when the override is applied over a stale variant #then the stale variant is cleared", async () => {
    // given
    const deps = createDeps()
    const sessionID = "session-no-variant-clears"
    const state = createFallbackState("anthropic/claude-opus-4-8")
    state.currentModel = "openai/gpt-5.4-mini"
    state.fallbackIndex = 0
    deps.sessionStates.set(sessionID, state)
    const handler = createChatMessageHandler(deps)
    const output: { message: { model?: { providerID: string; modelID: string }; variant?: string } } = { message: { variant: "xhigh" } }

    // when
    await handler({ sessionID }, output)

    // then
    expect(output.message.model).toEqual({ providerID: "openai", modelID: "gpt-5.4-mini" })
    expect(output.message.variant).toBeUndefined()
  })
})
