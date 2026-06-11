import { afterEach, describe, expect, test } from "bun:test"
import { tmpdir } from "node:os"

import type { PluginInput } from "@opencode-ai/plugin"

import { BackgroundManager } from "./manager"
import { clearAllApprovals, hasApproval, recordApproval } from "../../shared/external-directory-approvals"
import { unsafeTestValue } from "../../../test-support/unsafe-test-value"

function waitForSessionCreated(): {
  promise: Promise<string>
  resolve: (sessionID: string) => void
} {
  let resolveSession: (sessionID: string) => void = () => {}
  const promise = new Promise<string>((resolve) => {
    resolveSession = resolve
  })
  return { promise, resolve: resolveSession }
}

async function raceForSessionCreation(promise: Promise<string>, label: string): Promise<string> {
  return Promise.race([
    promise,
    new Promise<string>((_, reject) => {
      setTimeout(() => reject(new Error(`waited for ${label}`)), 1000)
    }),
  ])
}

describe("BackgroundManager session permission", () => {
  afterEach(() => {
    clearAllApprovals()
  })

  test("passes parent directory route when prompting the child session", async () => {
    // given
    const promptCalls: Array<Record<string, unknown>> = []
    const client = {
      session: {
        get: async () => ({ data: { directory: "/parent" } }),
        create: async () => ({ data: { id: "ses_child" } }),
        promptAsync: async (input: Record<string, unknown>) => {
          promptCalls.push(input)
          return {}
        },
        abort: async () => ({}),
      },
    }
    const manager = new BackgroundManager({ pluginContext: unsafeTestValue<PluginInput>({ client, directory: tmpdir() }) })

    // when
    await manager.launch({
      description: "Test task",
      prompt: "Do something",
      agent: "explore",
      parentSessionId: "ses_parent",
      parentMessageId: "msg_parent",
    })
    await new Promise(resolve => setTimeout(resolve, 50))
    manager.shutdown()

    // then
    expect(promptCalls).toHaveLength(1)
    expect(promptCalls[0]?.query).toEqual({ directory: "/parent" })
  })

  test("passes query directory when loading the parent session", async () => {
    // given
    const getCalls: Array<Record<string, unknown>> = []
    const client = {
      session: {
        get: async (input: Record<string, unknown>) => {
          getCalls.push(input)
          return { data: { directory: "/parent" } }
        },
        create: async () => ({ data: { id: "ses_child" } }),
        promptAsync: async () => ({}),
        abort: async () => ({}),
      },
    }
    const directory = tmpdir()
    const manager = new BackgroundManager({ pluginContext: unsafeTestValue<PluginInput>({ client, directory }) })

    // when
    await manager.launch({
      description: "Test task",
      prompt: "Do something",
      agent: "explore",
      parentSessionId: "ses_parent",
      parentMessageId: "msg_parent",
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    manager.shutdown()

    // then
    expect(getCalls).toHaveLength(2)
    expect(getCalls).toEqual([
      {
        path: { id: "ses_parent" },
        query: { directory },
      },
      {
        path: { id: "ses_parent" },
        query: { directory },
      },
    ])
  })

  test("passes explicit session permission rules to child session creation", async () => {
    // given
    const createCalls: Array<Record<string, unknown>> = []
    const client = {
      session: {
        get: async () => ({ data: { directory: "/parent" } }),
        create: async (input: Record<string, unknown>) => {
          createCalls.push(input)
          return { data: { id: "ses_child" } }
        },
        promptAsync: async () => ({}),
        abort: async () => ({}),
      },
    }
    const manager = new BackgroundManager({ pluginContext: unsafeTestValue<PluginInput>({ client, directory: tmpdir() }) })

    // when
    await manager.launch({
      description: "Test task",
      prompt: "Do something",
      agent: "explore",
      parentSessionId: "ses_parent",
      parentMessageId: "msg_parent",
      sessionPermission: [
        { permission: "question", action: "deny", pattern: "*" },
      ],
    })
    await new Promise(resolve => setTimeout(resolve, 50))
    manager.shutdown()

    // then
    expect(createCalls).toHaveLength(1)
    expect(createCalls[0]?.body).toEqual({
      parentID: "ses_parent",
      title: "Test task (@explore subagent)",
      permission: [
        { permission: "question", action: "deny", pattern: "*" },
      ],
    })
  })

  test("seeds explicit child permission rules with parent-approved external directories", async () => {
    // given
    const approvedDir = "/approved/external"
    const createCalls: Array<Record<string, unknown>> = []
    let resolveCreate: () => void = () => {}
    const createObserved = new Promise<void>((resolve) => {
      resolveCreate = resolve
    })
    recordApproval("ses_parent", approvedDir)
    const client = {
      session: {
        get: async () => ({ data: { directory: "/parent" } }),
        create: async (input: Record<string, unknown>) => {
          createCalls.push(input)
          resolveCreate()
          return { data: { id: "ses_child" } }
        },
        promptAsync: async () => ({}),
        abort: async () => ({}),
      },
    }
    const manager = new BackgroundManager({ pluginContext: unsafeTestValue<PluginInput>({ client, directory: tmpdir() }) })

    // when
    await manager.launch({
      description: "Test task",
      prompt: "Do something",
      agent: "explore",
      parentSessionId: "ses_parent",
      parentMessageId: "msg_parent",
      sessionPermission: [
        { permission: "question", action: "deny", pattern: "*" },
      ],
    })
    await createObserved
    manager.shutdown()

    // then
    expect(createCalls).toHaveLength(1)
    expect(createCalls[0]?.body).toEqual({
      parentID: "ses_parent",
      title: "Test task (@explore subagent)",
      permission: [
        { permission: "question", action: "deny", pattern: "*" },
        { permission: "external_directory", action: "allow", pattern: "/approved/external/**" },
      ],
    })
  })

  test("inherits only parent-approved external directories into the child session", async () => {
    // given
    const approvedDir = "/approved/external"
    const unapprovedDir = "/unapproved/external"
    recordApproval("ses_parent", approvedDir)
    const sessionCreated = waitForSessionCreated()
    const client = {
      session: {
        get: async () => ({ data: { directory: "/parent" } }),
        create: async () => ({ data: { id: "ses_child" } }),
        promptAsync: async () => ({}),
        abort: async () => ({}),
      },
    }
    const manager = new BackgroundManager({ pluginContext: unsafeTestValue<PluginInput>({ client, directory: tmpdir() }) })

    // when
    await manager.launch({
      description: "Test task",
      prompt: "Do something",
      agent: "explore",
      parentSessionId: "ses_parent",
      parentMessageId: "msg_parent",
      onSessionCreated: async (sessionID) => {
        sessionCreated.resolve(sessionID)
      },
    })
    const childSessionID = await Promise.race([
      sessionCreated.promise,
      new Promise<string>((_, reject) => {
        setTimeout(() => reject(new Error("waited for background child session creation")), 1000)
      }),
    ])
    manager.shutdown()

    // then
    expect(childSessionID).toBe("ses_child")
    expect(hasApproval("ses_child", approvedDir)).toBe(true)
    expect(hasApproval("ses_child", unapprovedDir)).toBe(false)
  })

  test("inherits retry-session approvals from explicit approval source", async () => {
    // given
    const approvedDir = "/retry/approved/external"
    const parentOnlyDir = "/parent/only/external"
    recordApproval("ses_previous_child", approvedDir)
    recordApproval("ses_parent", parentOnlyDir)
    const sessionCreated = waitForSessionCreated()
    const client = {
      session: {
        get: async () => ({ data: { directory: "/parent" } }),
        create: async () => ({ data: { id: "ses_retry_child" } }),
        promptAsync: async () => ({}),
        abort: async () => ({}),
      },
    }
    const manager = new BackgroundManager({ pluginContext: unsafeTestValue<PluginInput>({ client, directory: tmpdir() }) })

    // when
    await manager.launch({
      description: "Retry task",
      prompt: "Do something again",
      agent: "explore",
      parentSessionId: "ses_parent",
      parentMessageId: "msg_parent",
      approvalSourceSessionId: "ses_previous_child",
      onSessionCreated: async (sessionID) => {
        sessionCreated.resolve(sessionID)
      },
    })
    const retrySessionID = await Promise.race([
      sessionCreated.promise,
      new Promise<string>((_, reject) => {
        setTimeout(() => reject(new Error("waited for retry child session creation")), 1000)
      }),
    ])
    manager.shutdown()

    // then
    expect(retrySessionID).toBe("ses_retry_child")
    expect(hasApproval("ses_retry_child", approvedDir)).toBe(true)
    expect(hasApproval("ses_retry_child", parentOnlyDir)).toBe(false)
  })

  test("seeds retry child create payload from the approval source without leaking parent-only directories", async () => {
    // given
    const approvedDir = "/retry/approved/external"
    const parentOnlyDir = "/parent/only/external"
    const createCalls: Array<Record<string, unknown>> = []
    let resolveCreate: () => void = () => {}
    const createObserved = new Promise<void>((resolve) => {
      resolveCreate = resolve
    })
    recordApproval("ses_previous_child", approvedDir)
    recordApproval("ses_parent", parentOnlyDir)
    const client = {
      session: {
        get: async () => ({ data: { directory: "/parent" } }),
        create: async (input: Record<string, unknown>) => {
          createCalls.push(input)
          resolveCreate()
          return { data: { id: "ses_retry_child" } }
        },
        promptAsync: async () => ({}),
        abort: async () => ({}),
      },
    }
    const manager = new BackgroundManager({ pluginContext: unsafeTestValue<PluginInput>({ client, directory: tmpdir() }) })

    // when
    await manager.launch({
      description: "Retry task",
      prompt: "Do something again",
      agent: "explore",
      parentSessionId: "ses_parent",
      parentMessageId: "msg_parent",
      approvalSourceSessionId: "ses_previous_child",
      sessionPermission: [
        { permission: "question", action: "deny", pattern: "*" },
      ],
    })
    await createObserved
    manager.shutdown()

    // then
    expect(createCalls).toHaveLength(1)
    expect(createCalls[0]?.body).toEqual({
      parentID: "ses_parent",
      title: "Retry task (@explore subagent)",
      permission: [
        { permission: "question", action: "deny", pattern: "*" },
        { permission: "external_directory", action: "allow", pattern: "/retry/approved/external/**" },
      ],
    })
    expect(JSON.stringify(createCalls[0]?.body)).not.toContain(parentOnlyDir)
  })

  test("propagates parent approvals transitively into a nested grandchild session", async () => {
    // given
    const approvedDir = "/approved/nested/external"
    const unrelatedDir = "/unrelated/nested/external"
    recordApproval("ses_parent", approvedDir)
    const childCreated = waitForSessionCreated()
    const grandchildCreated = waitForSessionCreated()
    const createdSessionIDs = ["ses_child", "ses_grandchild"]
    const client = {
      session: {
        get: async () => ({ data: { directory: "/parent" } }),
        create: async () => ({ data: { id: createdSessionIDs.shift() } }),
        promptAsync: async () => ({}),
        abort: async () => ({}),
      },
    }
    const manager = new BackgroundManager({ pluginContext: unsafeTestValue<PluginInput>({ client, directory: tmpdir() }) })

    // when - depth 1: parent -> child (manager inherits before onSessionCreated fires)
    await manager.launch({
      description: "Child task",
      prompt: "Do something",
      agent: "explore",
      parentSessionId: "ses_parent",
      parentMessageId: "msg_parent",
      onSessionCreated: async (sessionID) => {
        childCreated.resolve(sessionID)
      },
    })
    const childSessionID = await raceForSessionCreation(childCreated.promise, "background child session creation")

    // depth 2: child -> grandchild, seeded from the already-inherited child approvals
    await manager.launch({
      description: "Grandchild task",
      prompt: "Do something deeper",
      agent: "explore",
      parentSessionId: childSessionID,
      parentMessageId: "msg_child",
      onSessionCreated: async (sessionID) => {
        grandchildCreated.resolve(sessionID)
      },
    })
    const grandchildSessionID = await raceForSessionCreation(grandchildCreated.promise, "background grandchild session creation")
    manager.shutdown()

    // then
    expect(childSessionID).toBe("ses_child")
    expect(grandchildSessionID).toBe("ses_grandchild")
    expect(hasApproval("ses_grandchild", approvedDir)).toBe(true)
    expect(hasApproval("ses_grandchild", unrelatedDir)).toBe(false)
  })

  test("seeds child permission rules with every parent-approved directory independently", async () => {
    // given
    const approvedDirA = "/approved/external-a"
    const approvedDirB = "/approved/external-b"
    const unrelatedDir = "/unrelated/external-c"
    const createCalls: Array<Record<string, unknown>> = []
    let resolveCreate: () => void = () => {}
    const createObserved = new Promise<void>((resolve) => {
      resolveCreate = resolve
    })
    recordApproval("ses_parent", approvedDirA)
    recordApproval("ses_parent", approvedDirB)
    const client = {
      session: {
        get: async () => ({ data: { directory: "/parent" } }),
        create: async (input: Record<string, unknown>) => {
          createCalls.push(input)
          resolveCreate()
          return { data: { id: "ses_child" } }
        },
        promptAsync: async () => ({}),
        abort: async () => ({}),
      },
    }
    const manager = new BackgroundManager({ pluginContext: unsafeTestValue<PluginInput>({ client, directory: tmpdir() }) })

    // when
    await manager.launch({
      description: "Test task",
      prompt: "Do something",
      agent: "explore",
      parentSessionId: "ses_parent",
      parentMessageId: "msg_parent",
      sessionPermission: [
        { permission: "question", action: "deny", pattern: "*" },
      ],
    })
    await createObserved
    manager.shutdown()

    // then
    expect(createCalls).toHaveLength(1)
    expect(createCalls[0]?.body).toEqual({
      parentID: "ses_parent",
      title: "Test task (@explore subagent)",
      permission: [
        { permission: "question", action: "deny", pattern: "*" },
        { permission: "external_directory", action: "allow", pattern: "/approved/external-a/**" },
        { permission: "external_directory", action: "allow", pattern: "/approved/external-b/**" },
      ],
    })
    expect(JSON.stringify(createCalls[0]?.body)).not.toContain(unrelatedDir)
  })
})
