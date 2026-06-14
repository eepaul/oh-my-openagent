import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { PluginInput } from "@opencode-ai/plugin"
import { createBoulderState, writeBoulderState } from "../../features/boulder-state"
import { _resetForTesting, registerAgentName } from "../../features/claude-code-session-state"
import {
  releaseAllPromptAsyncReservationsForTesting,
} from "../shared/prompt-async-gate"
import { readFinalWaveGate, writeFinalWaveGate } from "./final-wave-gate-store"
import { handleCompletedBoulderIdle } from "./idle-completion-nudge"
import type { SessionState } from "./types"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"

describe("handleCompletedBoulderIdle", () => {
  const SESSION_ID = "session-completion-test"

  let testDirectory = ""

  beforeEach(() => {
    testDirectory = join(tmpdir(), `idle-completion-nudge-${randomUUID()}`)
    if (!existsSync(testDirectory)) {
      mkdirSync(testDirectory, { recursive: true })
    }
    _resetForTesting()
    registerAgentName("atlas")
  })

  afterEach(() => {
    if (existsSync(testDirectory)) {
      rmSync(testDirectory, { recursive: true, force: true })
    }
    _resetForTesting()
    releaseAllPromptAsyncReservationsForTesting()
  })

  describe("#given completed boulder with work defined", () => {
    it("#when work completes (not abandoned), #then final-wave-gate sidecar is cleared", async () => {
      // given
      const planPath = join(testDirectory, "plan.md")
      writeFileSync(planPath, "## TODOs\n- [x] 1. Task done\n")

      const boulder = createBoulderState(planPath, SESSION_ID, "atlas")
      const workId = boulder.active_work_id
      if (!workId) {
        throw new Error("Expected active_work_id")
      }

      const work = boulder.works?.[workId]
      if (!work) {
        throw new Error("Expected active work")
      }

      work.elapsed_ms = 5_000
      work.status = "completed"
      boulder.elapsed_ms = 5_000
      writeBoulderState(testDirectory, boulder)

      // Seed the gate for this work
      writeFinalWaveGate(testDirectory, {
        work_id: workId,
        plan_name: "plan",
        approved_count: 1,
        pending_count: 1,
        updated_at: new Date().toISOString(),
      })

      // Verify gate exists before completion
      const gateBeforeCompletion = readFinalWaveGate(testDirectory, workId)
      expect(gateBeforeCompletion).not.toBeNull()
      expect(gateBeforeCompletion?.work_id).toBe(workId)

      const promptAsyncMock = mock(async () => ({ data: {} }))
      const ctx = unsafeTestValue<PluginInput>({
        directory: testDirectory,
        client: {
          session: {
            promptAsync: promptAsyncMock,
          },
        },
      })

      const sessionState: SessionState = {
        promptFailureCount: 0,
      }

      const boulderState = boulder

      // when
      await handleCompletedBoulderIdle({
        ctx,
        sessionID: SESSION_ID,
        sessionState,
        boulderState,
      })

      // then
      const gateAfterCompletion = readFinalWaveGate(testDirectory, workId)
      expect(gateAfterCompletion).toBeNull()
    })

    it("#when work is abandoned, #then final-wave-gate is NOT cleared", async () => {
      // given
      const planPath = join(testDirectory, "plan.md")
      writeFileSync(planPath, "## TODOs\n- [ ] 1. Task abandoned\n")

      const boulder = createBoulderState(planPath, SESSION_ID, "atlas")
      const workId = boulder.active_work_id
      if (!workId) {
        throw new Error("Expected active_work_id")
      }

      const work = boulder.works?.[workId]
      if (!work) {
        throw new Error("Expected active work")
      }

      // Mark work as abandoned before writing
      work.status = "abandoned"
      boulder.status = "abandoned"
      writeBoulderState(testDirectory, boulder)

      // Seed the gate for this work
      writeFinalWaveGate(testDirectory, {
        work_id: workId,
        plan_name: "plan",
        approved_count: 0,
        pending_count: 1,
        updated_at: new Date().toISOString(),
      })

      // Verify gate exists before completion attempt
      const gateBeforeCompletion = readFinalWaveGate(testDirectory, workId)
      expect(gateBeforeCompletion).not.toBeNull()

      const promptAsyncMock = mock(async () => ({ data: {} }))
      const ctx = unsafeTestValue<PluginInput>({
        directory: testDirectory,
        client: {
          session: {
            promptAsync: promptAsyncMock,
          },
        },
      })

      const sessionState: SessionState = {
        promptFailureCount: 0,
      }

      const boulderState = boulder

      // when
      await handleCompletedBoulderIdle({
        ctx,
        sessionID: SESSION_ID,
        sessionState,
        boulderState,
      })

      // then
      const gateAfterCompletion = readFinalWaveGate(testDirectory, workId)
      expect(gateAfterCompletion).not.toBeNull()
      expect(gateAfterCompletion?.work_id).toBe(workId)
    })
  })
})
