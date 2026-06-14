/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createBoulderState, writeBoulderState } from "../../features/boulder-state"
import { _resetForTesting } from "../../features/claude-code-session-state"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"
import { readFinalWaveGate, writeFinalWaveGate } from "../atlas/final-wave-gate-store"
import { handleSessionIdle } from "./idle-event"
import type { SessionStateStore } from "./session-state"
import type { ContinuationProgressUpdate, SessionState, Todo } from "./types"

const FINAL_WAVE_PLAN =
  "## TODOs\n- [x] 1. Implement feature\n\n## Final Verification Wave\n- [ ] F1. Verify everything\n"

function createStateStore(): {
  store: SessionStateStore
  resetCalls: string[]
  trackCalls: string[]
  state: SessionState
} {
  const state: SessionState = {
    stagnationCount: 0,
    consecutiveFailures: 0,
  }
  const resetCalls: string[] = []
  const trackCalls: string[] = []
  const progressUpdate: ContinuationProgressUpdate = {
    previousStagnationCount: 0,
    stagnationCount: 0,
    hasProgressed: false,
    progressSource: "none",
  }

  return {
    resetCalls,
    trackCalls,
    state,
    store: {
      getState: () => state,
      getExistingState: () => state,
      startPruneInterval: () => {},
      trackContinuationProgress: (sessionID: string) => {
        trackCalls.push(sessionID)
        return progressUpdate
      },
      resetContinuationProgress: (sessionID: string) => {
        resetCalls.push(sessionID)
      },
      cancelCountdown: () => {
        if (state.countdownTimer) {
          clearTimeout(state.countdownTimer)
          state.countdownTimer = undefined
        }
        if (state.countdownInterval) {
          clearInterval(state.countdownInterval)
          state.countdownInterval = undefined
        }
        state.countdownStartedAt = undefined
        state.inFlight = false
      },
      cleanup: () => {},
      cancelAllCountdowns: () => {},
      shutdown: () => {},
    },
  }
}

const INCOMPLETE_TODOS: { data: Todo[] } = {
  data: [{ id: "todo-1", content: "Verify everything", status: "pending", priority: "high" }],
}

function makeCtx(testDirectory: string): PluginInput {
  return unsafeTestValue<PluginInput>({
    directory: testDirectory,
    client: {
      tui: {
        showToast: async () => ({ data: true }),
      },
      session: {
        messages: async () => ({ data: [] }),
        todo: async () => INCOMPLETE_TODOS,
      },
    },
  })
}

describe("handleSessionIdle final-wave gate consult", () => {
  const SESSION_ID = "session-enforcer-final-wave"

  let testDirectory = ""

  beforeEach(() => {
    testDirectory = join(tmpdir(), `enforcer-final-wave-${randomUUID()}`)
    if (!existsSync(testDirectory)) {
      mkdirSync(testDirectory, { recursive: true })
    }
    _resetForTesting()
  })

  afterEach(() => {
    if (existsSync(testDirectory)) {
      rmSync(testDirectory, { recursive: true, force: true })
    }
    _resetForTesting()
  })

  it("#given a boulder awaiting durable final-wave approval with incomplete session todos #when the session idles #then no continuation is driven", async () => {
    // given
    const planPath = join(testDirectory, "plan.md")
    writeFileSync(planPath, FINAL_WAVE_PLAN)

    const boulder = createBoulderState(planPath, SESSION_ID, "sisyphus")
    const workId = boulder.active_work_id
    if (!workId) {
      throw new Error("Expected active_work_id")
    }
    const planName = boulder.works?.[workId]?.plan_name
    if (!planName) {
      throw new Error("Expected work plan_name")
    }
    writeBoulderState(testDirectory, boulder)

    writeFinalWaveGate(testDirectory, {
      work_id: workId,
      plan_name: planName,
      approved_count: 0,
      pending_count: 1,
      updated_at: new Date().toISOString(),
    })

    const { store, trackCalls, state } = createStateStore()

    try {
      // when
      await handleSessionIdle({ ctx: makeCtx(testDirectory), sessionID: SESSION_ID, sessionStateStore: store })

      // then: gate consult returned before the injection path
      expect(trackCalls).toEqual([])
      expect(state.countdownStartedAt).toBeUndefined()
      // the durable gate is a valid awaiting gate, so it must NOT be cleared
      expect(readFinalWaveGate(testDirectory, workId)).not.toBeNull()
    } finally {
      store.cancelCountdown(SESSION_ID)
    }
  })

  it("#given the same boulder + incomplete session todos but NO durable gate #when the session idles #then the enforcer DOES drive a continuation (control: proves the gate is the only thing blocking)", async () => {
    // given
    const planPath = join(testDirectory, "plan.md")
    writeFileSync(planPath, FINAL_WAVE_PLAN)

    const boulder = createBoulderState(planPath, SESSION_ID, "sisyphus")
    const workId = boulder.active_work_id
    if (!workId) {
      throw new Error("Expected active_work_id")
    }
    writeBoulderState(testDirectory, boulder)
    // intentionally NO writeFinalWaveGate(...)
    expect(readFinalWaveGate(testDirectory, workId)).toBeNull()

    const { store, trackCalls, state } = createStateStore()

    try {
      // when
      await handleSessionIdle({ ctx: makeCtx(testDirectory), sessionID: SESSION_ID, sessionStateStore: store })

      // then: without the durable gate the enforcer reaches the injection path
      expect(trackCalls).toEqual([SESSION_ID])
      expect(state.countdownStartedAt).toBeGreaterThan(0)
    } finally {
      store.cancelCountdown(SESSION_ID)
    }
  })
})
