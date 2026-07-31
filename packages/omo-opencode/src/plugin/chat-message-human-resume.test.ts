import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { enterWaitingOnHuman } from "@oh-my-opencode/boulder-state"
import { unsafeTestValue } from "../../../../test-support/unsafe-test-value"
import type { OhMyOpenCodeConfig } from "../config"
import { createBoulderState, getWorkById, writeBoulderState } from "../features/boulder-state"
import { createCompactionGraceTracker } from "../hooks/shared/compaction-grace-tracker"
import { createChatMessageHandler } from "./chat-message"
import type { PluginContext } from "./types"

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

describe("chat.message human resume", () => {
  let directory = ""
  let sessionID = ""
  let workID = ""

  beforeEach(() => {
    directory = join(tmpdir(), `chat-message-human-resume-${randomUUID()}`)
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
    return createChatMessageHandler({
      ctx: unsafeTestValue<PluginContext>({
        directory,
        client: { tui: { showToast: async () => {} } },
      }),
      pluginConfig: unsafeTestValue<OhMyOpenCodeConfig>({}),
      firstMessageVariantGate: { shouldOverride: () => false, markApplied: () => {} },
      hooks: unsafeTestValue({}),
      compactionGraceTracker: tracker,
    })
  }

  test("#given a bound waiting work #when chat.message receives real text #then the delayed resume activates the work", async () => {
    // given
    expect(enterWaitingOnHuman(directory, workID, { reason: "Need input", source: "plan-blocked" })).toBeTrue()
    const { tracker, tasks } = createManualTracker()
    const handler = createHandler(tracker)

    // when
    await handler(
      { sessionID, messageID: "msg-1" },
      { message: { id: "msg-1" }, parts: [{ type: "text", text: "Approved." }] },
    )
    const task = tasks[0]
    if (task === undefined) throw new Error("expected delayed resume")
    await task.run()

    // then
    expect(getWorkById(directory, workID)?.status).toBe("active")
    expect(getWorkById(directory, workID)?.waiting).toBeUndefined()
  })

  test("#given bound waiting work #when any non-stop slash command reaches chat.message #then it never schedules resume", async () => {
    // given
    expect(enterWaitingOnHuman(directory, workID, { reason: "Need input", source: "plan-blocked" })).toBeTrue()
    const { tracker, tasks } = createManualTracker()
    const handler = createHandler(tracker)

    // when
    for (const command of ["/start-work", "/other"]) {
      await handler(
        { sessionID, messageID: `msg-${command}` },
        { message: { id: `msg-${command}` }, parts: [{ type: "text", text: command }] },
      )
    }

    // then
    expect(tasks).toHaveLength(0)
    expect(getWorkById(directory, workID)?.status).toBe("waiting_on_human")
  })

  test("#given waiting work belongs to another session #when chat.message receives real text #then the unbound message cannot schedule a resume", async () => {
    // given
    expect(enterWaitingOnHuman(directory, workID, { reason: "Need input", source: "plan-blocked" })).toBeTrue()
    const { tracker, tasks } = createManualTracker()
    const handler = createHandler(tracker)

    // when
    await handler(
      { sessionID: `ses-unbound-${randomUUID()}`, messageID: "msg-unbound" },
      { message: { id: "msg-unbound" }, parts: [{ type: "text", text: "Approved." }] },
    )

    // then
    expect(tasks).toHaveLength(0)
    expect(getWorkById(directory, workID)?.status).toBe("waiting_on_human")
  })

  test("#given an internally initiated user message #when chat.message receives it #then waiting state remains unchanged", async () => {
    // given
    expect(enterWaitingOnHuman(directory, workID, { reason: "Need input", source: "plan-blocked" })).toBeTrue()
    const { tracker, tasks } = createManualTracker()
    const handler = createHandler(tracker)

    // when
    await handler(
      { sessionID, messageID: "msg-internal" },
      { message: { id: "msg-internal" }, parts: [{ type: "text", text: "continue <!-- OMO_INTERNAL_INITIATOR -->" }] },
    )

    // then
    expect(tasks).toHaveLength(0)
    expect(getWorkById(directory, workID)?.status).toBe("waiting_on_human")
  })

  test("#given session.compacted was observed #when a real chat.message arrives within grace #then it cannot schedule a resume", async () => {
    // given
    expect(enterWaitingOnHuman(directory, workID, { reason: "Need input", source: "plan-blocked" })).toBeTrue()
    const { tracker, tasks } = createManualTracker()
    tracker.recordCompaction(sessionID)
    const handler = createHandler(tracker)

    // when
    await handler(
      { sessionID, messageID: "msg-grace" },
      { message: { id: "msg-grace" }, parts: [{ type: "text", text: "Approved." }] },
    )

    // then
    expect(tasks).toHaveLength(0)
    expect(getWorkById(directory, workID)?.status).toBe("waiting_on_human")
  })

  test("#given waiting work #when /stop-continuation reaches chat.message #then it archives before any resume can run", async () => {
    // given
    expect(enterWaitingOnHuman(directory, workID, { reason: "Need input", source: "plan-blocked" })).toBeTrue()
    const { tracker, tasks } = createManualTracker()
    const handler = createHandler(tracker)

    // when
    await handler(
      { sessionID, messageID: "msg-stop" },
      { message: { id: "msg-stop" }, parts: [{ type: "text", text: "/stop-continuation" }] },
    )

    // then
    expect(tasks).toHaveLength(0)
    const archiveName = readdirSync(join(directory, ".omo")).find((name) => name.startsWith("boulder.json.stopped-"))
    if (archiveName === undefined) throw new Error("expected boulder archive")
    const archived = readFileSync(join(directory, ".omo", archiveName), "utf8")
    expect(archived).toContain('"status": "waiting_on_human"')
  })
})
