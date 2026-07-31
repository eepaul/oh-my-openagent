import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { PluginInput } from "@opencode-ai/plugin"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { enterWaitingOnHuman } from "@oh-my-opencode/boulder-state"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"
import { createBoulderState, getWorkById, writeBoulderState } from "../../features/boulder-state"
import { createCompactionGraceTracker } from "../shared/compaction-grace-tracker"
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

describe("Atlas event human resume", () => {
  let directory = ""
  let sessionID = ""
  let workID = ""

  beforeEach(() => {
    directory = join(tmpdir(), `atlas-event-human-resume-${randomUUID()}`)
    mkdirSync(directory, { recursive: true })
    sessionID = `ses-${randomUUID()}`
    const planPath = join(directory, "plan.md")
    writeFileSync(planPath, "## TODOs\n- [ ] 1. Continue\n")
    const state = createBoulderState(planPath, sessionID, "atlas")
    workID = state.active_work_id ?? ""
    writeBoulderState(directory, state)
  })

  afterEach(() => {
    if (existsSync(directory)) rmSync(directory, { recursive: true, force: true })
  })

  function createHandler(tracker: ReturnType<typeof createCompactionGraceTracker>) {
    const sessions = new Map<string, SessionState>()
    const ctx = unsafeTestValue<PluginInput>({
      directory,
      project: {},
      worktree: directory,
      serverUrl: new URL("http://localhost"),
      $: {},
      client: createOpencodeClient({ baseUrl: "http://localhost" }),
      experimental_workspace: { register: () => {} },
    })
    return createAtlasEventHandler({
      ctx,
      sessions,
      getState: () => ({ promptFailureCount: 0 }),
      compactionGraceTracker: tracker,
    })
  }

  function userMessage(text: string, messageID: string): AtlasEvent {
    return {
      event: {
        type: "message.updated",
        properties: {
          info: { id: messageID, sessionID, role: "user" },
          parts: [{ type: "text", text }],
        },
      },
    }
  }

  test("#given a bound waiting work #when message.updated receives real user text #then its delayed resume activates the work", async () => {
    // given
    expect(enterWaitingOnHuman(directory, workID, { reason: "Need input", source: "plan-blocked" })).toBeTrue()
    const { tracker, tasks } = createManualTracker()
    const handler = createHandler(tracker)

    // when
    await handler(userMessage("Approved.", "msg-1"))
    const task = tasks[0]
    if (task === undefined) throw new Error("expected delayed resume")
    await task.run()

    // then
    expect(getWorkById(directory, workID)?.status).toBe("active")
  })

  test("#given plan-blocked waiting #when a Question part completion arrives #then it cannot resume by matching only a part ID", async () => {
    // given
    expect(enterWaitingOnHuman(directory, workID, { reason: "Need input", source: "plan-blocked" })).toBeTrue()
    const { tracker } = createManualTracker()
    const handler = createHandler(tracker)

    // when
    await handler({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            id: "call-question",
            sessionID,
            type: "tool",
            tool: "question",
            callID: "call-other",
            state: { status: "completed" },
          },
        },
      },
    })

    // then
    expect(getWorkById(directory, workID)?.status).toBe("waiting_on_human")
  })

  test("#given question-tool waiting #when the completed Question call ID exactly matches #then the event resumes it", async () => {
    // given
    expect(enterWaitingOnHuman(directory, workID, {
      reason: "Need answer",
      source: "question-tool",
      question_call_id: "call-question",
    })).toBeTrue()
    const { tracker } = createManualTracker()
    const handler = createHandler(tracker)

    // when
    await handler({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            id: "part-not-a-call-id",
            sessionID,
            type: "tool",
            tool: "question",
            callID: "call-question",
            state: { status: "completed" },
          },
        },
      },
    })

    // then
    expect(getWorkById(directory, workID)?.status).toBe("active")
    expect(getWorkById(directory, workID)?.waiting).toBeUndefined()
  })

  test("#given bound waiting work #when any slash command reaches message.updated #then it does not schedule a human resume", async () => {
    // given
    expect(enterWaitingOnHuman(directory, workID, { reason: "Need input", source: "plan-blocked" })).toBeTrue()
    const { tracker, tasks } = createManualTracker()
    const handler = createHandler(tracker)

    // when
    for (const command of ["/stop-continuation", "/start-work", "/other"]) {
      await handler(userMessage(command, `msg-${command}`))
    }

    // then
    expect(tasks).toHaveLength(0)
    expect(getWorkById(directory, workID)?.status).toBe("waiting_on_human")
  })

  test("#given a message arrives before session.compacted #when compaction is observed in the ordering window #then the delayed state resume is dropped", async () => {
    // given
    expect(enterWaitingOnHuman(directory, workID, { reason: "Need input", source: "plan-blocked" })).toBeTrue()
    const { tracker, tasks } = createManualTracker()
    const handler = createHandler(tracker)
    await handler(userMessage("Approved.", "msg-1"))
    const task = tasks[0]
    if (task === undefined) throw new Error("expected delayed resume")

    // when
    await handler({ event: { type: "session.compacted", properties: { sessionID } } })
    await task.run()

    // then
    expect(getWorkById(directory, workID)?.status).toBe("waiting_on_human")
  })
})
