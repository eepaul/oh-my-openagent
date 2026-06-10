import { afterEach, describe, expect, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { BackgroundManager } from "./manager"
import type { BackgroundTask } from "./types"
import { releaseAllPromptAsyncReservationsForTesting } from "../../hooks/shared/prompt-async-gate"

type PromptAsyncCall = {
  path: { id: string }
  body: {
    noReply?: boolean
    parts?: unknown[]
  }
  query?: {
    directory: string
  }
}

type PendingParentWakeForTest = {
  notifications: string[]
  shouldReply: boolean
}

let managerUnderTest: BackgroundManager | undefined

afterEach(() => {
  managerUnderTest?.shutdown()
  releaseAllPromptAsyncReservationsForTesting()
  managerUnderTest = undefined
})

function createTask(overrides: Partial<BackgroundTask> & { id: string; parentSessionId: string }): BackgroundTask {
  const id = overrides.id
  const parentSessionID = overrides.parentSessionId
  const { id: _ignoredID, parentSessionId: _ignoredParentSessionID, ...rest } = overrides

  return {
    parentMessageId: overrides.parentMessageId ?? "parent-message-id",
    description: overrides.description ?? overrides.id,
    prompt: overrides.prompt ?? `Prompt for ${overrides.id}`,
    agent: overrides.agent ?? "test-agent",
    status: overrides.status ?? "running",
    startedAt: overrides.startedAt ?? new Date("2026-05-20T14:19:10.000Z"),
    ...rest,
    id,
    parentSessionId: parentSessionID,
  }
}

function createManager(sessionStatuses: Record<string, { type: string }>): {
  manager: BackgroundManager
  promptAsyncCalls: PromptAsyncCall[]
} {
  const promptAsyncCalls: PromptAsyncCall[] = []
  const client = {
    session: {
      messages: async () => [],
      status: async () => ({ data: sessionStatuses }),
      prompt: async () => ({}),
      promptAsync: async (call: PromptAsyncCall) => {
        promptAsyncCalls.push(call)
        return {}
      },
      abort: async () => ({}),
    },
  }
  const ctx: PluginInput = {
    client: client as unknown as PluginInput["client"],
    project: {} as PluginInput["project"],
    directory: "/tmp",
    worktree: "/tmp",
    experimental_workspace: { register: () => {} },
    serverUrl: new URL("http://localhost"),
    $: {} as PluginInput["$"],
  }

  const manager = new BackgroundManager({
    pluginContext: ctx,
    config: undefined,
    enableParentSessionNotifications: true,
  })

  return { manager, promptAsyncCalls }
}

function getTasks(manager: BackgroundManager): Map<string, BackgroundTask> {
  return Reflect.get(manager, "tasks") as Map<string, BackgroundTask>
}

function getPendingByParent(manager: BackgroundManager): Map<string, Set<string>> {
  return Reflect.get(manager, "pendingByParent") as Map<string, Set<string>>
}

function getPendingParentWakes(manager: BackgroundManager): Map<string, PendingParentWakeForTest> {
  const parentWakeNotifier = Reflect.get(manager, "parentWakeNotifier") as {
    getPendingParentWakes: () => Map<string, PendingParentWakeForTest>
  }
  return parentWakeNotifier.getPendingParentWakes()
}

async function notifyParentSessionForTest(manager: BackgroundManager, task: BackgroundTask): Promise<void> {
  const notifyParentSession = Reflect.get(manager, "notifyParentSession") as (task: BackgroundTask) => Promise<void>
  return notifyParentSession.call(manager, task)
}

async function flushPendingParentWakeForTest(manager: BackgroundManager, sessionID: string): Promise<void> {
  const flushPendingParentWake = Reflect.get(manager, "flushPendingParentWake") as (sessionID: string) => Promise<void>
  return flushPendingParentWake.call(manager, sessionID)
}

describe("BackgroundManager parent wake recent idle resume", () => {
  test("#when a single background task completes after the parent ended its turn and went idle #then the all-complete wake produces a reply rather than an admit-only wake", async () => {
    // given a parent session whose latest reported status is idle
    const sessionStatuses: Record<string, { type: string }> = {
      "parent-1": { type: "idle" },
    }
    const { manager, promptAsyncCalls } = createManager(sessionStatuses)
    managerUnderTest = manager

    // and the parent produced output and then ended its turn: recent activity, then idle
    manager.handleEvent({
      type: "message.part.delta",
      properties: {
        sessionID: "parent-1",
        field: "reasoning",
        delta: "wrapping up the parent turn",
      },
    })
    manager.handleEvent({ type: "session.idle", properties: { sessionID: "parent-1" } })

    // and a single background task that finishes after the parent turn already ended
    const task = createTask({
      id: "task-a",
      parentSessionId: "parent-1",
      description: "task A",
      status: "completed",
      completedAt: new Date("2026-05-20T14:19:14.625Z"),
    })
    getTasks(manager).set(task.id, task)
    getPendingByParent(manager).set(task.parentSessionId, new Set([task.id]))

    // when the completion is reported, the queued wake is an all-complete reply wake
    await notifyParentSessionForTest(manager, task)
    const queuedWake = getPendingParentWakes(manager).get("parent-1")
    expect(queuedWake?.shouldReply).toBe(true)

    // and the pending wake is flushed against the idle parent
    await flushPendingParentWakeForTest(manager, "parent-1")

    // then the parent is woken with a reply-producing prompt, not stranded as admit-only
    expect(promptAsyncCalls).toHaveLength(1)
    expect(promptAsyncCalls[0]?.body.noReply).toBe(false)
  })
})
