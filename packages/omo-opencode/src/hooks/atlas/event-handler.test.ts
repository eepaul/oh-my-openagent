import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { PluginInput } from "@opencode-ai/plugin"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { createBoulderState, writeBoulderState } from "../../features/boulder-state"
import { createAtlasEventHandler } from "./event-handler"
import { type FinalWaveGate, readFinalWaveGate, writeFinalWaveGate } from "./final-wave-gate-store"
import type { SessionState } from "./types"

type AtlasEvent = { event: { type: string; properties?: unknown } }

const GATE_WORK_ID = "atlas-final-wave-loop-fix"

function createHarness(directory: string): {
  handler: (arg: AtlasEvent) => Promise<void>
  sessions: Map<string, SessionState>
} {
  const sessions = new Map<string, SessionState>()
  function getState(sessionID: string): SessionState {
    let state = sessions.get(sessionID)
    if (!state) {
      state = { promptFailureCount: 0 }
      sessions.set(sessionID, state)
    }
    return state
  }

  const client = createOpencodeClient({ baseUrl: "http://localhost" })
  const ctx: PluginInput = {
    directory,
    project: {} as PluginInput["project"],
    worktree: directory,
    serverUrl: new URL("http://localhost"),
    $: {} as PluginInput["$"],
    client,
    experimental_workspace: { register: () => {} },
  }

  const handler = createAtlasEventHandler({ ctx, options: { directory }, sessions, getState })
  return { handler, sessions }
}

function createGate(): FinalWaveGate {
  return {
    work_id: GATE_WORK_ID,
    plan_name: "final-wave-plan",
    approved_count: 1,
    pending_count: 3,
    updated_at: "2026-06-13T00:00:00Z",
  }
}

function userMessageEvent(sessionID: string, parts: unknown[]): AtlasEvent {
  return {
    event: {
      type: "message.updated",
      properties: {
        info: { id: `msg-${randomUUID()}`, sessionID, role: "user" },
        parts,
      },
    },
  }
}

function compactedEvent(sessionID: string): AtlasEvent {
  return {
    event: {
      type: "session.compacted",
      properties: { sessionID },
    },
  }
}

const realTextPart = { type: "text", text: "please continue the work" }
const syntheticTextPart = { type: "text", text: "internal continuation nudge", synthetic: true }

describe("createAtlasEventHandler final-wave gate clearing", () => {
  let directory = ""

  beforeEach(() => {
    directory = join(tmpdir(), `atlas-event-handler-${randomUUID()}`)
    mkdirSync(join(directory, ".omo"), { recursive: true })
  })

  afterEach(() => {
    if (existsSync(directory)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("synthetic user message does not clear the gate or the waiting flag", async () => {
    // given
    const { handler, sessions } = createHarness(directory)
    const sessionID = `ses-${randomUUID()}`
    sessions.set(sessionID, { promptFailureCount: 0, waitingForFinalWaveApproval: true })
    writeFinalWaveGate(directory, createGate())

    // when
    await handler(userMessageEvent(sessionID, [syntheticTextPart]))

    // then
    expect(readFinalWaveGate(directory, GATE_WORK_ID)).not.toBeNull()
    expect(sessions.get(sessionID)?.waitingForFinalWaveApproval).toBe(true)
  })

  test("real user message past the compaction grace clears the gate and the waiting flag", async () => {
    // given
    const { handler, sessions } = createHarness(directory)
    const sessionID = `ses-${randomUUID()}`
    sessions.set(sessionID, { promptFailureCount: 0, waitingForFinalWaveApproval: true })

    // Seed boulder state so getWorkForSession resolves this session's work_id;
    // keyed removal clears only that work's gate (a real awaiting session always
    // has boulder state, unlike the prior nuke-all-on-empty-id behavior).
    const planPath = join(directory, "plan.md")
    writeFileSync(planPath, "## TODOs\n- [x] 1. done\n")
    const boulder = createBoulderState(planPath, sessionID, "atlas")
    const workId = boulder.active_work_id
    if (!workId) {
      throw new Error("Expected active_work_id")
    }
    writeBoulderState(directory, boulder)
    writeFinalWaveGate(directory, { ...createGate(), work_id: workId })

    // when
    await handler(userMessageEvent(sessionID, [realTextPart]))

    // then
    expect(readFinalWaveGate(directory, workId)).toBeNull()
    expect(sessions.get(sessionID)?.waitingForFinalWaveApproval).toBe(false)
  })

  test("real user message within the compaction grace window does not clear the gate or flag", async () => {
    // given
    const { handler, sessions } = createHarness(directory)
    const sessionID = `ses-${randomUUID()}`
    writeFinalWaveGate(directory, createGate())

    // when
    await handler(compactedEvent(sessionID))
    sessions.set(sessionID, { promptFailureCount: 0, waitingForFinalWaveApproval: true })
    await handler(userMessageEvent(sessionID, [realTextPart]))

    // then
    expect(readFinalWaveGate(directory, GATE_WORK_ID)).not.toBeNull()
    expect(sessions.get(sessionID)?.waitingForFinalWaveApproval).toBe(true)
  })

  test("abort and runtime-retry resets still run for synthetic messages", async () => {
    // given
    const { handler, sessions } = createHarness(directory)
    const sessionID = `ses-${randomUUID()}`
    sessions.set(sessionID, {
      promptFailureCount: 0,
      lastEventWasAbortError: true,
      skipNextIdleAfterRuntimeErrorRetry: true,
      waitingForFinalWaveApproval: true,
    })

    // when
    await handler(userMessageEvent(sessionID, [syntheticTextPart]))

    // then
    const state = sessions.get(sessionID)
    expect(state?.lastEventWasAbortError).toBe(false)
    expect(state?.skipNextIdleAfterRuntimeErrorRetry).toBe(false)
    expect(state?.waitingForFinalWaveApproval).toBe(true)
  })
})
