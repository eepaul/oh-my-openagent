import { afterEach, describe, expect, test } from "bun:test"

import { createSyncSession } from "./sync-session-creator"
import { clearAllApprovals, hasApproval, recordApproval } from "../../shared/external-directory-approvals"

describe("createSyncSession", () => {
  afterEach(() => {
    clearAllApprovals()
  })

  test("creates child session with question permission denied", async () => {
    // given
    const createCalls: Array<Record<string, unknown>> = []
    const client = {
      session: {
        get: async () => ({ data: { directory: "/parent" } }),
        create: async (input: Record<string, unknown>) => {
          createCalls.push(input)
          return { data: { id: "ses_child" } }
        },
      },
    }

    // when
    const result = await createSyncSession(client as never, {
      parentSessionID: "ses_parent",
      agentToUse: "explore",
      description: "test task",
      defaultDirectory: "/fallback",
    })

    // then
    expect(result).toEqual({ ok: true, sessionID: "ses_child", parentDirectory: "/parent" })
    expect(createCalls).toHaveLength(1)
    expect(createCalls[0]?.body).toEqual({
      parentID: "ses_parent",
      title: "test task (@explore subagent)",
      permission: [
        { permission: "question", action: "deny", pattern: "*" },
      ],
    })
  })

  test("inherits parent-approved directories without granting unapproved siblings", async () => {
    // given
    const approvedDir = "/approved/external"
    const unapprovedDir = "/unapproved/external"
    recordApproval("ses_parent", approvedDir)
    const client = {
      session: {
        get: async () => ({ data: { directory: "/parent" } }),
        create: async () => ({ data: { id: "ses_child" } }),
      },
    }

    // when
    const result = await createSyncSession(client as never, {
      parentSessionID: "ses_parent",
      agentToUse: "explore",
      description: "test task",
      defaultDirectory: "/fallback",
    })

    // then
    expect(result).toEqual({ ok: true, sessionID: "ses_child", parentDirectory: "/parent" })
    expect(hasApproval("ses_child", approvedDir)).toBe(true)
    expect(hasApproval("ses_child", unapprovedDir)).toBe(false)
  })

  test("inherits approvals transitively from parent to child to grandchild", async () => {
    // given
    const approvedDir = "/approved/transitive/external"
    const otherDir = "/approved/transitive-other/external"
    const createdSessionIDs = ["ses_child", "ses_grandchild"]
    recordApproval("ses_parent", approvedDir)
    const client = {
      session: {
        get: async () => ({ data: { directory: "/parent" } }),
        create: async () => ({ data: { id: createdSessionIDs.shift() } }),
      },
    }

    // when
    const childResult = await createSyncSession(client as never, {
      parentSessionID: "ses_parent",
      agentToUse: "explore",
      description: "child task",
      defaultDirectory: "/fallback",
    })
    const grandchildResult = await createSyncSession(client as never, {
      parentSessionID: "ses_child",
      agentToUse: "explore",
      description: "grandchild task",
      defaultDirectory: "/fallback",
    })

    // then
    expect(childResult).toEqual({ ok: true, sessionID: "ses_child", parentDirectory: "/parent" })
    expect(grandchildResult).toEqual({ ok: true, sessionID: "ses_grandchild", parentDirectory: "/parent" })
    expect(hasApproval("ses_grandchild", approvedDir)).toBe(true)
    expect(hasApproval("ses_grandchild", otherDir)).toBe(false)
  })

  test("keeps multi-directory approval keys exact across inheritance", async () => {
    // given
    const dirA = "/approved/external-a"
    const dirB = "/approved/external-b"
    recordApproval("ses_parent", dirA)
    const client = {
      session: {
        get: async () => ({ data: { directory: "/parent" } }),
        create: async () => ({ data: { id: "ses_child" } }),
      },
    }

    // when
    const result = await createSyncSession(client as never, {
      parentSessionID: "ses_parent",
      agentToUse: "explore",
      description: "multi-dir task",
      defaultDirectory: "/fallback",
    })

    // then
    expect(result).toEqual({ ok: true, sessionID: "ses_child", parentDirectory: "/parent" })
    expect(hasApproval("ses_child", dirA)).toBe(true)
    expect(hasApproval("ses_child", dirB)).toBe(false)
  })
})
