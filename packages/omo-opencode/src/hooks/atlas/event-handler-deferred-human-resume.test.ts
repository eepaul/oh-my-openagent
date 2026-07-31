import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { PluginInput } from "@opencode-ai/plugin"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { enterWaitingOnHuman, resumeFromHuman } from "@oh-my-opencode/boulder-state"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"
import { addBoulderWork, createBoulderState, getWorkById, writeBoulderState } from "../../features/boulder-state"
import { createCompactionGraceTracker } from "../shared/compaction-grace-tracker"
import { recordHumanResumeAndClear, resetWaitingFailClosedGateForTesting } from "../shared/waiting-fail-closed-gate"
import { createAtlasEventHandler } from "./event-handler"
import type { SessionState } from "./types"

type AtlasEvent = { readonly event: { readonly type: string; readonly properties?: unknown } }
type ManualTask = { readonly run: () => Promise<void> }

function createManualTracker(): {
  readonly tasks: ManualTask[]
  readonly tracker: ReturnType<typeof createCompactionGraceTracker>
} {
  const tasks: ManualTask[] = []
  const tracker = createCompactionGraceTracker({
    now: () => 1,
    schedule: (callback) => {
      tasks.push({ run: callback })
      return { cancel: () => {} }
    },
  })
  return { tasks, tracker }
}

describe("Atlas deferred real-user message resume", () => {
  let directory = ""
  let sessionID = ""
  let workID = ""

  beforeEach(() => {
    directory = join(tmpdir(), `atlas-deferred-human-resume-${randomUUID()}`)
    mkdirSync(directory, { recursive: true })
    sessionID = `ses-${randomUUID()}`
    const planPath = join(directory, "plan-target.md")
    writeFileSync(planPath, "## TODOs\n- [ ] 1. Continue\n")
    const state = createBoulderState(planPath, sessionID, "atlas")
    workID = state.active_work_id ?? ""
    writeBoulderState(directory, state)
  })

  afterEach(() => {
    resetWaitingFailClosedGateForTesting()
    if (existsSync(directory)) rmSync(directory, { recursive: true, force: true })
  })

  function createHandler(tracker: ReturnType<typeof createCompactionGraceTracker>) {
    const sessions = new Map<string, SessionState>()
    return createAtlasEventHandler({
      ctx: unsafeTestValue<PluginInput>({
        directory,
        project: {},
        worktree: directory,
        serverUrl: new URL("http://localhost"),
        $: {},
        client: createOpencodeClient({ baseUrl: "http://localhost" }),
        experimental_workspace: { register: () => {} },
      }),
      sessions,
      getState: () => ({ promptFailureCount: 0 }),
      compactionGraceTracker: tracker,
    })
  }

  function userMessageStarted(messageID: string, targetSessionID = sessionID): AtlasEvent {
    return {
      event: {
        type: "message.updated",
        properties: { info: { id: messageID, sessionID: targetSessionID, role: "user" } },
      },
    }
  }

  function userTextPart(messageID: string, text: string, targetSessionID = sessionID): AtlasEvent {
    return {
      event: {
        type: "message.part.updated",
        properties: { part: { messageID, sessionID: targetSessionID, type: "text", text } },
      },
    }
  }

  test("#given OpenCode sends user metadata before its text part #when the real matching text part arrives #then the waiting work resumes after the shared delay", async () => {
    // given
    expect(enterWaitingOnHuman(directory, workID, { reason: "Need input", source: "plan-blocked" })).toBeTrue()
    const { tracker, tasks } = createManualTracker()
    const handler = createHandler(tracker)

    // when
    await handler(userMessageStarted("msg-real"))
    expect(tasks).toHaveLength(0)
    await handler(userTextPart("msg-real", "Approved."))
    const task = tasks[0]
    if (task === undefined) throw new Error("expected delayed resume from text part")
    await task.run()

    // then
    expect(getWorkById(directory, workID)?.status).toBe("active")
    expect(getWorkById(directory, workID)?.waiting).toBeUndefined()
  })

  test("#given deferred user metadata #when internal, slash, unrelated, or duplicate parts arrive #then only one matching real answer is scheduled", async () => {
    // given
    expect(enterWaitingOnHuman(directory, workID, { reason: "Need input", source: "plan-blocked" })).toBeTrue()
    const { tracker, tasks } = createManualTracker()
    const handler = createHandler(tracker)

    // when
    await handler(userMessageStarted("msg-internal"))
    await handler(userTextPart("msg-internal", "<!-- OMO_INTERNAL_INITIATOR -->"))
    await handler(userMessageStarted("msg-command"))
    await handler(userTextPart("msg-command", "/start-work"))
    await handler(userMessageStarted("msg-real"))
    await handler(userTextPart("msg-unrelated", "Approved."))
    await handler(userTextPart("msg-real", "Approved."))
    await handler(userTextPart("msg-real", "Approved."))

    // then
    expect(tasks).toHaveLength(1)
    expect(getWorkById(directory, workID)?.status).toBe("waiting_on_human")
  })

  test("#given deferred user metadata #when compaction grace begins or a new episode supersedes the snapshot before fire #then neither delayed resume changes the waiting work", async () => {
    // given
    expect(enterWaitingOnHuman(directory, workID, { reason: "Need input", source: "plan-blocked" })).toBeTrue()
    const grace = createManualTracker()
    const graceHandler = createHandler(grace.tracker)
    await graceHandler(userMessageStarted("msg-grace"))
    await graceHandler(userTextPart("msg-grace", "Approved."))
    const graceTask = grace.tasks[0]
    if (graceTask === undefined) throw new Error("expected delayed grace resume")
    grace.tracker.recordCompaction(sessionID)
    await graceTask.run()
    const stale = createManualTracker()
    const staleHandler = createHandler(stale.tracker)
    await staleHandler(userMessageStarted("msg-stale"))
    await staleHandler(userTextPart("msg-stale", "Approved."))
    const staleTask = stale.tasks[0]
    if (staleTask === undefined) throw new Error("expected delayed stale resume")
    await recordHumanResumeAndClear(directory, workID)
    expect(resumeFromHuman(directory, workID)).toBeTrue()
    expect(enterWaitingOnHuman(directory, workID, { reason: "New episode", source: "plan-blocked" })).toBeTrue()

    // when
    await staleTask.run()

    // then
    expect(stale.tasks).toHaveLength(1)
    expect(getWorkById(directory, workID)?.status).toBe("waiting_on_human")
  })

  test("#given another active work exists #when deferred text resumes the target session #then the other work remains byte-equivalent", async () => {
    // given
    const otherPlanPath = join(directory, "plan-other.md")
    writeFileSync(otherPlanPath, "## TODOs\n- [ ] 1. Other\n")
    const added = addBoulderWork(directory, { planPath: otherPlanPath, sessionId: "ses-other" })
    const otherWorkID = added?.active_work_id
    if (otherWorkID === undefined) throw new Error("expected other work")
    const beforeOtherWork = getWorkById(directory, otherWorkID)
    expect(enterWaitingOnHuman(directory, workID, { reason: "Need input", source: "plan-blocked" })).toBeTrue()
    const { tracker, tasks } = createManualTracker()
    const handler = createHandler(tracker)

    // when
    await handler(userMessageStarted("msg-target"))
    await handler(userTextPart("msg-target", "Approved."))
    const task = tasks[0]
    if (task === undefined) throw new Error("expected delayed target resume")
    await task.run()

    // then
    expect(getWorkById(directory, workID)?.status).toBe("active")
    expect(getWorkById(directory, otherWorkID)).toEqual(beforeOtherWork)
  })
})
