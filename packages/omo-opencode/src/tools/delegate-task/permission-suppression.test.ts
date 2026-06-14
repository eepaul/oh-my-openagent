import { describe, expect, test } from "bun:test"

import { createSyncSession } from "./sync-session-creator"
import { QUESTION_DENIED_SESSION_PERMISSION } from "../../shared/question-denied-session-permission"

/**
 * A1 PROBE (real wiring) — Does the repo's child-spawn path actually place an
 * `external_directory: "allow"` grant into the child session request, thereby
 * suppressing the external-directory prompt for that child?
 *
 * This drives the REAL production function `createSyncSession`
 * (src/tools/delegate-task/sync-session-creator.ts) with a body-capturing mock
 * OpenCode client — the same pattern as
 * src/features/background-agent/manager-session-permission.test.ts — and
 * asserts on the ACTUAL request object the repo builds. No invented resolver.
 *
 * Real-wiring facts under test:
 *  - createSyncSession hardcodes `permission: QUESTION_DENIED_SESSION_PERMISSION`
 *    into the child session.create body (sync-session-creator.ts:24) and exposes
 *    NO parameter to inject an external_directory grant.
 *  - The spawn permission channel is typed `sessionPermission?: SessionPermissionRule[]`
 *    (src/features/background-agent/types.ts:77,122) and the background spawner
 *    forwards it verbatim into `body.permission` (spawner.ts:60). A
 *    SessionPermissionRule is `{ permission, action, pattern }`
 *    (src/shared/question-denied-session-permission.ts:1-9) — a RULE ARRAY with
 *    no object-map slot for `external_directory`.
 *  - The canonical `external_directory: "allow"` grant is an OBJECT MAP applied
 *    to MAIN agents only (src/plugin-handlers/tool-config-handler.ts:147-152).
 */

function makeBodyCapturingClient(createCalls: Array<Record<string, unknown>>) {
  return {
    session: {
      get: async () => ({ data: { directory: "/parent" } }),
      create: async (input: Record<string, unknown>) => {
        createCalls.push(input)
        return { data: { id: "ses_child" } }
      },
    },
  }
}

function ruleArrayGrantsExternalDirectory(permission: unknown): boolean {
  if (!Array.isArray(permission)) return false
  return permission.some(
    (rule) =>
      typeof rule === "object" &&
      rule !== null &&
      (rule as { permission?: unknown }).permission === "external_directory",
  )
}

describe("A1 probe (real wiring): external_directory grant without parent approval", () => {
  describe("#given the real createSyncSession child-spawn path without stored approvals", () => {
    test("#when a child session is created #then the actual request carries NO external_directory grant", async () => {
      // given — the real child-spawn function, with a client that captures the
      // exact request object the repo builds
      const createCalls: Array<Record<string, unknown>> = []
      const client = makeBodyCapturingClient(createCalls)

      // when — drive the actual production child-spawn function
      const result = await createSyncSession(client as never, {
        parentSessionID: "ses_parent",
        agentToUse: "explore",
        description: "probe task",
        defaultDirectory: "/fallback",
      })

      // then — the real request the repo builds has an ARRAY-typed permission
      // channel (rule list), structurally incapable of carrying the object-map
      // `external_directory: "allow"` grant, and no rule grants external_directory.
      // The allow grant cannot reach the child through this path.
      expect(result).toEqual({ ok: true, sessionID: "ses_child", parentDirectory: "/parent" })
      expect(createCalls).toHaveLength(1)
      const body = createCalls[0]?.body as { permission?: unknown }
      expect(Array.isArray(body?.permission)).toBe(true)
      expect(ruleArrayGrantsExternalDirectory(body?.permission)).toBe(false)
      expect(JSON.stringify(createCalls[0]?.body)).not.toContain("external_directory")
    })
  })

  describe("#given the unapproved control payload on the same real path", () => {
    test("#when a child session is created #then body.permission is QUESTION_DENIED_SESSION_PERMISSION, which lacks external_directory (child still prompts)", async () => {
      // given
      const createCalls: Array<Record<string, unknown>> = []
      const client = makeBodyCapturingClient(createCalls)

      // when — same real production function
      await createSyncSession(client as never, {
        parentSessionID: "ses_parent",
        agentToUse: "explore",
        description: "probe task",
        defaultDirectory: "/fallback",
      })

      // then — the actual permission shipped is the current control rule array;
      // no parent approval exists, so the child's external-directory prompt is
      // NOT suppressed and the control remains sensitive
      const body = createCalls[0]?.body as { permission?: unknown }
      expect(body?.permission).toEqual(QUESTION_DENIED_SESSION_PERMISSION)
      const grantedPermissions = QUESTION_DENIED_SESSION_PERMISSION.map((rule) => rule.permission)
      expect(grantedPermissions).toEqual(["question"])
      expect(grantedPermissions).not.toContain("external_directory")
    })
  })
})
