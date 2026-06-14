/// <reference path="../../../../bun-test.d.ts" />
import { afterEach, describe, expect, it } from "bun:test"

import { createEventHandler } from "./event"
import { clearAllApprovals, clearAllPending, hasApproval } from "../shared/external-directory-approvals"

type EventHandlerArgs = Parameters<typeof createEventHandler>[0]
type EventHandlerInput = Parameters<ReturnType<typeof createEventHandler>>[0]

function cast<T>(value: unknown): T {
  return value as T
}

function createHandler(): ReturnType<typeof createEventHandler> {
  return createEventHandler({
    ctx: cast<EventHandlerArgs["ctx"]>({}),
    pluginConfig: cast<EventHandlerArgs["pluginConfig"]>({}),
    firstMessageVariantGate: {
      markSessionCreated: () => {},
      clear: () => {},
    },
    managers: cast<EventHandlerArgs["managers"]>({
      tmuxSessionManager: {
        onEvent: () => {},
        onSessionCreated: async () => {},
        onSessionDeleted: async () => {},
      },
      skillMcpManager: {
        disconnectSession: async () => {},
      },
    }),
    hooks: cast<EventHandlerArgs["hooks"]>({}),
  })
}

async function sendAsked(handler: ReturnType<typeof createEventHandler>, overrides: Record<string, unknown> = {}) {
  await handler(cast<EventHandlerInput>({
    event: {
      type: "permission.asked",
      properties: {
        id: "req_external",
        sessionID: "ses_external",
        permission: "external_directory",
        metadata: { parentDir: "/tmp/omo-task7-parent" },
        patterns: ["/tmp/omo-task7-parent/*"],
        always: ["/tmp/omo-task7-parent/*"],
        ...overrides,
      },
    },
  }))
}

async function sendAskedFor(
  handler: ReturnType<typeof createEventHandler>,
  requestID: string,
  sessionID: string,
  parentDir: string,
  overrides: Record<string, unknown> = {},
) {
  await sendAsked(handler, {
    id: requestID,
    sessionID,
    metadata: { parentDir },
    patterns: [`${parentDir}/*`],
    always: [`${parentDir}/*`],
    ...overrides,
  })
}

async function sendReplied(handler: ReturnType<typeof createEventHandler>, reply: string, requestID = "req_external") {
  await sendRepliedFor(handler, "ses_external", requestID, reply)
}

async function sendRepliedFor(
  handler: ReturnType<typeof createEventHandler>,
  sessionID: string,
  requestID: string,
  reply: string,
) {
  await handler(cast<EventHandlerInput>({
    event: {
      type: "permission.replied",
      properties: {
        sessionID,
        requestID,
        reply,
      },
    },
  }))
}

afterEach(() => {
  clearAllApprovals()
  clearAllPending()
})

describe("createEventHandler - external-directory permission approval events", () => {
  it("#given external-directory ask #when reply is always #then records approval for pending parent dir", async () => {
    //#given
    const handler = createHandler()
    await sendAsked(handler)

    //#when
    await sendReplied(handler, "always")

    //#then
    expect(hasApproval("ses_external", "/tmp/omo-task7-parent")).toBe(true)
  })

  it("#given external-directory ask #when reply is once #then consumes pending without recording approval", async () => {
    //#given
    const handler = createHandler()
    await sendAsked(handler)

    //#when
    await sendReplied(handler, "once")
    await sendReplied(handler, "always")

    //#then
    expect(hasApproval("ses_external", "/tmp/omo-task7-parent")).toBe(false)
  })

  it("#given external-directory ask #when reply is reject #then consumes pending without recording approval", async () => {
    //#given
    const handler = createHandler()
    await sendAsked(handler)

    //#when
    await sendReplied(handler, "reject")
    await sendReplied(handler, "always")

    //#then
    expect(hasApproval("ses_external", "/tmp/omo-task7-parent")).toBe(false)
  })

  it("#given no matching ask #when reply is always #then records no approval", async () => {
    //#given
    const handler = createHandler()

    //#when
    await sendReplied(handler, "always", "missing_request")

    //#then
    expect(hasApproval("ses_external", "/tmp/omo-task7-parent")).toBe(false)
  })

  it("#given non-external ask #when reply is always #then records no approval", async () => {
    //#given
    const handler = createHandler()
    await sendAsked(handler, { permission: "bash" })

    //#when
    await sendReplied(handler, "always")

    //#then
    expect(hasApproval("ses_external", "/tmp/omo-task7-parent")).toBe(false)
  })

  it("#given concurrent external-directory asks #when B is always and A is once #then only B is recorded", async () => {
    //#given
    const handler = createHandler()
    await sendAskedFor(handler, "reqA", "ses_concurrent", "/tmp/omo-a")
    await sendAskedFor(handler, "reqB", "ses_concurrent", "/tmp/omo-b")

    //#when
    await sendRepliedFor(handler, "ses_concurrent", "reqB", "always")
    await sendRepliedFor(handler, "ses_concurrent", "reqA", "once")

    //#then
    expect(hasApproval("ses_concurrent", "/tmp/omo-a")).toBe(false)
    expect(hasApproval("ses_concurrent", "/tmp/omo-b")).toBe(true)
  })

  it("#given same requestID in different sessions #when one session replies always #then the sibling session is not consumed", async () => {
    //#given
    const handler = createHandler()
    await sendAskedFor(handler, "req_shared", "ses_a", "/tmp/omo-session-a")
    await sendAskedFor(handler, "req_shared", "ses_b", "/tmp/omo-session-b")

    //#when
    await sendRepliedFor(handler, "ses_b", "req_shared", "always")
    await sendRepliedFor(handler, "ses_a", "req_shared", "once")

    //#then
    expect(hasApproval("ses_a", "/tmp/omo-session-a")).toBe(false)
    expect(hasApproval("ses_b", "/tmp/omo-session-b")).toBe(true)
  })

  it("#given external-directory ask missing parentDir #when reply is always #then records no approval", async () => {
    //#given
    const handler = createHandler()
    await sendAsked(handler, { metadata: { filepath: "/tmp/omo-task12-parent/file.txt" } })

    //#when
    await sendReplied(handler, "always")

    //#then
    expect(hasApproval("ses_external", "/tmp/omo-task12-parent")).toBe(false)
  })

  it("#given external-directory ask with non-string parentDir #when reply is always #then records no approval", async () => {
    //#given
    const handler = createHandler()
    await sendAsked(handler, { metadata: { parentDir: ["/tmp/omo-task12-parent"] } })

    //#when
    await sendReplied(handler, "always")

    //#then
    expect(hasApproval("ses_external", "/tmp/omo-task12-parent")).toBe(false)
  })

  it("#given external-directory ask with relative parentDir #when reply is always #then records no approval", async () => {
    //#given
    const handler = createHandler()
    await sendAsked(handler, { metadata: { parentDir: "relative/omo-task12-parent" } })

    //#when
    await sendReplied(handler, "always")

    //#then
    expect(hasApproval("ses_external", "/tmp/omo-task12-parent")).toBe(false)
  })

  it("#given external-directory ask with invalid parentDir #when reply is always #then records no approval", async () => {
    //#given
    const handler = createHandler()
    const invalidParentDir = "/tmp/omo-task12-parent\u0000ambiguous"
    await sendAsked(handler, { metadata: { parentDir: invalidParentDir } })

    //#when
    await sendReplied(handler, "always")

    //#then
    expect(hasApproval("ses_external", invalidParentDir)).toBe(false)
  })

  it("#given non-external ask between external asks #when replies arrive #then non-external state does not affect approval seeding", async () => {
    //#given
    const handler = createHandler()
    await sendAskedFor(handler, "req_external_a", "ses_mixed", "/tmp/omo-mixed-a")
    await sendAskedFor(handler, "req_non_external", "ses_mixed", "/tmp/omo-mixed-b", { permission: "bash" })

    //#when
    await sendRepliedFor(handler, "ses_mixed", "req_non_external", "always")
    await sendRepliedFor(handler, "ses_mixed", "req_external_a", "always")

    //#then
    expect(hasApproval("ses_mixed", "/tmp/omo-mixed-a")).toBe(true)
    expect(hasApproval("ses_mixed", "/tmp/omo-mixed-b")).toBe(false)
  })
})
