import { describe, expect, test } from "bun:test"
import { ParentWakeNotifier } from "./parent-wake-notifier"
import {
  releaseAllPromptAsyncReservationsForTesting,
  releasePromptAsyncReservation,
} from "../../hooks/shared/prompt-async-gate"

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

type SessionMessageStub = {
  info?: {
    role?: string
    finish?: string
    time?: { created?: number }
  }
  parts?: Array<{ type?: string; text?: string; state?: { status?: string } }>
}

function createNotifier(args: {
  sessionStatuses: Record<string, { type: string }>
  getMessages: () => SessionMessageStub[]
}): {
  notifier: ParentWakeNotifier
  promptAsyncCalls: PromptAsyncCall[]
} {
  const promptAsyncCalls: PromptAsyncCall[] = []
  const client = {
    session: {
      messages: async () => ({ data: args.getMessages() }),
      status: async () => ({ data: args.sessionStatuses }),
      promptAsync: async (call: PromptAsyncCall) => {
        promptAsyncCalls.push(call)
        return { data: {} }
      },
      abort: async () => ({ data: {} }),
    },
  } as unknown as ConstructorParameters<typeof ParentWakeNotifier>[0]["client"]

  const notifier = new ParentWakeNotifier(
    {
      client,
      directory: "/tmp/test-omo",
      enqueueNotificationForParent: async (_sessionID, operation) => {
        await operation()
      },
    },
    {
      pendingRetryMs: 60_000,
      acceptedMessageSkewMs: 5_000,
      toolCallDeferMaxMs: 5_000,
      failureRequeueWindowMs: 60_000,
      userMessageInProgressWindowMs: 0,
    },
  )

  return { notifier, promptAsyncCalls }
}

describe("ParentWakeNotifier — tool-wait deferral resumes a reply once idle", () => {
  test("#given a reply-needed wake is deferred for an in-progress tool call #when the parent turn goes idle #then the reply still dispatches with noReply:false instead of being consumed", async () => {
    // given a parent whose latest assistant turn is still waiting on a running tool call
    const sessionID = "parent-toolwait-resume"
    const baseUserMessage: SessionMessageStub = {
      info: { role: "user", time: { created: Date.now() - 20_000 } },
      parts: [{ type: "text", text: "kick off the work" }],
    }
    const toolWaitingMessages: SessionMessageStub[] = [
      baseUserMessage,
      {
        info: { role: "assistant", finish: "tool-calls", time: { created: Date.now() - 1_000 } },
        parts: [{ type: "tool", state: { status: "running" } }],
      },
    ]
    const idleMessages: SessionMessageStub[] = [
      baseUserMessage,
      {
        info: { role: "assistant", finish: "stop", time: { created: Date.now() - 100 } },
        parts: [{ type: "text", text: "the tool finished, here is the result" }],
      },
    ]
    let currentMessages: SessionMessageStub[] = toolWaitingMessages
    const { notifier, promptAsyncCalls } = createNotifier({
      sessionStatuses: { [sessionID]: { type: "idle" } },
      getMessages: () => currentMessages,
    })
    // a reply-needed wake (shouldReply: true) arrives while the tool call blocks the turn
    notifier.queuePendingParentWake(sessionID, "background work finished", { agent: "sisyphus" }, true)

    try {
      // when the wake flushes while the tool call is still in progress
      await notifier.flushPendingParentWake(sessionID)

      // then the reply is correctly held back during the tool wait — no reply-producing dispatch yet
      expect(promptAsyncCalls.filter((call) => call.body.noReply === false)).toHaveLength(0)

      // and once the running tool resolves, the parent turn settles to idle
      releasePromptAsyncReservation(sessionID, "test:tool-wait-cleared", {
        reservedBy: "background-agent-parent-wake",
      })
      currentMessages = idleMessages

      // when the wake flushes again now that the parent is idle
      await notifier.flushPendingParentWake(sessionID)

      // then the reply-needed wake must finally fire as a reply rather than being consumed by the deferral
      const sawReplyDispatch = promptAsyncCalls.some((call) => call.body.noReply === false)
      expect(sawReplyDispatch).toBe(true)
    } finally {
      notifier.shutdown()
      releaseAllPromptAsyncReservationsForTesting()
    }
  })
})
