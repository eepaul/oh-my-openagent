/// <reference path="../../../../bun-test.d.ts" />
import { afterEach, describe, expect, mock, test } from "bun:test"

import { clearAllApprovals, clearAllPending, hasApproval } from "../shared/external-directory-approvals"
import { createEventHandler } from "./event"

// This regression documents a PROVEN upstream/core-owned OpenCode limitation, not a plugin-fixable
// bug. Task 1 first captured the external-directory re-ask loop as a RED baseline. Wave 0B (Tasks 2,
// 3) and Task 9 then established that the main-session loop cannot be resolved plugin-side with the
// available APIs:
//   - the `permission.ask` hook does not fire in the target runtime (Task 2);
//   - SDK `permission.reply()` returns PermissionNotFoundError for once/always/reject and does not
//     resolve a live prompt (Task 2);
//   - no plugin retry/continuation owner re-drives the call; OpenCode core re-emits a fresh
//     `permission.asked` with a new requestID for the same logical access after a terminal reply
//     (Task 3).
// See .omo/evidence/task-9-upstream-limitation-report.md.
//
// The scenario that was RED in Task 1 is therefore asserted here as the real, observed behavior at
// the plugin event boundary:
//   (1) the post-reject duplicate `permission.asked` STILL surfaces -- the plugin neither can nor
//       should suppress a core re-ask (suppressing without a genuine approval would cross the
//       permission security boundary); and
//   (2) the plugin-owned write path stays correct: a terminal `reject` records NO approval.
// If either invariant ever changes (core stops re-asking, or the plugin starts recording on reject)
// this test fails and forces a re-evaluation of the documented upstream limitation.

type EventHandlerArgs = Parameters<typeof createEventHandler>[0]
type EventHandlerInput = Parameters<ReturnType<typeof createEventHandler>>[0]

type PermissionTraceEntry = {
  order: number
  type: "permission.asked" | "permission.replied"
  sessionID: string
  requestID: string
  parentDir?: string
  reply?: "once" | "always" | "reject"
}

type PermissionAskedInput = {
  event: {
    id: string
    type: "permission.asked"
    properties: {
      id: string
      sessionID: string
      permission: string
      patterns: string[]
      metadata: Record<string, unknown>
      always: string[]
      tool?: {
        messageID: string
        callID: string
      }
    }
  }
}

type PermissionRepliedInput = {
  event: {
    id: string
    type: "permission.replied"
    properties: {
      sessionID: string
      requestID: string
      reply: "once" | "always" | "reject"
    }
  }
}

type PermissionEventInput = PermissionAskedInput | PermissionRepliedInput

function asEventHandlerContext(ctx: unknown): EventHandlerArgs["ctx"] {
  return ctx as EventHandlerArgs["ctx"]
}

function asPluginConfig(config: unknown): EventHandlerArgs["pluginConfig"] {
  return config as EventHandlerArgs["pluginConfig"]
}

function asManagers(managers: unknown): EventHandlerArgs["managers"] {
  return managers as EventHandlerArgs["managers"]
}

function asHooks(hooks: unknown): EventHandlerArgs["hooks"] {
  return hooks as EventHandlerArgs["hooks"]
}

function asEventHandlerInput(input: PermissionEventInput): EventHandlerInput {
  return input as unknown as EventHandlerInput
}

function createPermissionAskedEvent(args: {
  requestID: string
  sessionID: string
  parentDir: string
  filePath: string
}): EventHandlerInput {
  return asEventHandlerInput({
    event: {
      id: `evt-${args.requestID}`,
      type: "permission.asked",
      properties: {
        id: args.requestID,
        sessionID: args.sessionID,
        permission: "external_directory",
        patterns: [`${args.parentDir}/*`],
        metadata: {
          filepath: args.filePath,
          parentDir: args.parentDir,
        },
        always: [`${args.parentDir}/*`],
        tool: {
          messageID: "msg_external_dir",
          callID: "call_read_external_dir",
        },
      },
    },
  })
}

function createPermissionRepliedEvent(args: {
  requestID: string
  sessionID: string
  reply: "once" | "always" | "reject"
}): EventHandlerInput {
  return asEventHandlerInput({
    event: {
      id: `evt-replied-${args.requestID}`,
      type: "permission.replied",
      properties: {
        sessionID: args.sessionID,
        requestID: args.requestID,
        reply: args.reply,
      },
    },
  })
}

function createTracingEventHandler(trace: PermissionTraceEntry[]): ReturnType<typeof createEventHandler> {
  return createEventHandler({
    ctx: asEventHandlerContext({ directory: "/home/paul/projects/oh-my-openagent" }),
    pluginConfig: asPluginConfig({}),
    firstMessageVariantGate: {
      markSessionCreated: () => {},
      clear: () => {},
    },
    managers: asManagers({
      tmuxSessionManager: {
        onEvent: () => {},
        onSessionCreated: async () => {},
        onSessionDeleted: async () => {},
      },
    }),
    hooks: asHooks({
      sessionNotification: mock(async (input: EventHandlerInput) => {
        const { event } = input as unknown as PermissionEventInput
        if (event.type === "permission.asked") {
          trace.push({
            order: trace.length + 1,
            type: event.type,
            sessionID: event.properties.sessionID,
            requestID: event.properties.id,
            parentDir: typeof event.properties.metadata.parentDir === "string"
              ? event.properties.metadata.parentDir
              : undefined,
          })
        }
        if (event.type === "permission.replied") {
          trace.push({
            order: trace.length + 1,
            type: event.type,
            sessionID: event.properties.sessionID,
            requestID: event.properties.requestID,
            reply: event.properties.reply,
          })
        }
      }),
    }),
  })
}

describe("external-directory permission ask-loop (upstream/core-owned limitation)", () => {
  afterEach(() => {
    clearAllApprovals()
    clearAllPending()
  })

  test("#given an external-directory ask is rejected #when core re-asks the same access #then the duplicate ask still surfaces and reject records no approval", async () => {
    //#given
    const sessionID = "ses_external_directory_upstream"
    const parentDir = "/tmp/omo-ext-task1-upstream"
    const filePath = `${parentDir}/secret.txt`
    const trace: PermissionTraceEntry[] = []
    const eventHandler = createTracingEventHandler(trace)

    //#when
    await eventHandler(createPermissionAskedEvent({ requestID: "perm_1", sessionID, parentDir, filePath }))
    await eventHandler(createPermissionRepliedEvent({ requestID: "perm_1", sessionID, reply: "reject" }))
    await eventHandler(createPermissionAskedEvent({ requestID: "perm_2", sessionID, parentDir, filePath }))

    //#then the upstream-owned duplicate ask is observable; the plugin does not suppress core re-asks
    expect(trace).toEqual([
      {
        order: 1,
        type: "permission.asked",
        sessionID,
        requestID: "perm_1",
        parentDir,
      },
      {
        order: 2,
        type: "permission.replied",
        sessionID,
        requestID: "perm_1",
        reply: "reject",
      },
      {
        order: 3,
        type: "permission.asked",
        sessionID,
        requestID: "perm_2",
        parentDir,
      },
    ])

    //#then the plugin-owned approval store is untouched by a terminal reject
    expect(hasApproval(sessionID, parentDir)).toBe(false)
  })
})
