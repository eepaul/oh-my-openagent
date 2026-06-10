import { describe, expect, test } from "bun:test"
import {
  releaseAllPromptAsyncReservationsForTesting,
  releasePromptAsyncReservation,
} from "../../hooks/shared/prompt-async-gate"
import { ParentWakeNotifier } from "./parent-wake-notifier"

type ParentWakeNotifierClientForTest = ConstructorParameters<typeof ParentWakeNotifier>[0]["client"]
type PromptAsyncCall = Parameters<ParentWakeNotifierClientForTest["session"]["promptAsync"]>[0]

type SessionMessageStub = {
  info?: {
    role?: string
    finish?: string
    time?: { created?: number }
  }
  parts?: Array<{ type?: string; text?: string }>
}

const PROGRESS_WAKE = "<system-reminder>\n[BACKGROUND TASK RESULT READY]\n**ID:** `task-a`\n**1 task still in progress.** You WILL be notified when ALL complete.\n</system-reminder>"
const ALL_COMPLETE_WAKE = "<system-reminder>\n[BACKGROUND TASK COMPLETED]\n[ALL BACKGROUND TASKS COMPLETE]\n**Completed:**\n- `task-a`: alpha\n- `task-b`: beta\n</system-reminder>"

function idleAssistantMessage(): SessionMessageStub {
  return { info: { role: "assistant", finish: "stop", time: { created: Date.now() - 10_000 } } }
}

function createNotifier(): {
  readonly notifier: ParentWakeNotifier
  readonly promptAsyncCalls: PromptAsyncCall[]
} {
  const promptAsyncCalls: PromptAsyncCall[] = []
  const sessionMessages: SessionMessageStub[] = [idleAssistantMessage()]
  const client: ParentWakeNotifierClientForTest = {
    session: {
      messages: async () => ({ data: sessionMessages }),
      status: async () => ({ data: {} }),
      promptAsync: async (call: PromptAsyncCall) => {
        promptAsyncCalls.push(call)
        return { data: {} }
      },
    },
  }

  const notifier = new ParentWakeNotifier(
    {
      client,
      directory: "/tmp/test-omo",
      enqueueNotificationForParent: async (_sessionID, operation) => {
        await operation()
      },
    },
    {
      pendingRetryMs: 1_000,
      acceptedMessageSkewMs: 100,
      toolCallDeferMaxMs: 5_000,
      failureRequeueWindowMs: 5_000,
      userMessageInProgressWindowMs: 60_000,
      parentSessionActivityInProgressWindowMs: 60_000,
    },
  )

  return {
    notifier,
    promptAsyncCalls,
  }
}

function releaseParentWakeHold(sessionID: string): void {
  const released = releasePromptAsyncReservation(sessionID, "test:simulate-expired-parent-wake-hold", {
    reservedBy: "background-agent-parent-wake",
  })
  expect(released).toBe(true)
}

describe("ParentWakeNotifier — admit-only wake must not suppress a later reply wake", () => {
  test("#given an earlier progress wake was admitted with noReply #when the all-complete reply wake fires #then it produces a reply-bearing dispatch", async () => {
    // given
    const { notifier, promptAsyncCalls } = createNotifier()
    const sessionID = "parent-progress-admit-then-final-reply"
    notifier.queuePendingParentWake(sessionID, PROGRESS_WAKE, { agent: "sisyphus" }, false)

    try {
      await notifier.flushPendingParentWake(sessionID)
      expect(promptAsyncCalls).toHaveLength(1)
      expect(promptAsyncCalls[0]?.body.noReply).toBe(true)
      expect(notifier.getDispatchedParentWakes().get(sessionID)?.shouldReply).toBe(false)
      expect(notifier.getDispatchedParentWakes().get(sessionID)?.replyProduced).toBe(false)
      releaseParentWakeHold(sessionID)

      // when
      notifier.queuePendingParentWake(sessionID, ALL_COMPLETE_WAKE, { agent: "sisyphus" }, true)
      await notifier.flushPendingParentWake(sessionID)

      // then
      expect(promptAsyncCalls).toHaveLength(2)
      expect(promptAsyncCalls[1]?.body.noReply).toBe(false)
      expect(notifier.getPendingParentWakes().has(sessionID)).toBe(false)
    } finally {
      notifier.shutdown()
      releaseAllPromptAsyncReservationsForTesting()
    }
  })

  test("#given an all-complete reply wake was admitted with noReply because parent activity was fresh #when the same all-complete reply wake fires again after the parent idles #then the redundancy gate must not suppress the reply-bearing dispatch", async () => {
    // given
    const { notifier, promptAsyncCalls } = createNotifier()
    const sessionID = "parent-final-admit-only-poisons-reply"
    notifier.recordParentSessionActivity(sessionID)
    notifier.queuePendingParentWake(sessionID, ALL_COMPLETE_WAKE, { agent: "sisyphus" }, true)

    try {
      await notifier.flushPendingParentWake(sessionID)
      expect(promptAsyncCalls).toHaveLength(1)
      expect(promptAsyncCalls[0]?.body.noReply).toBe(true)
      expect(notifier.getDispatchedParentWakes().get(sessionID)?.shouldReply).toBe(true)
      expect(notifier.getDispatchedParentWakes().get(sessionID)?.replyProduced).toBe(false)
      releaseParentWakeHold(sessionID)

      // when
      notifier.recordParentSessionIdle(sessionID)
      notifier.queuePendingParentWake(sessionID, ALL_COMPLETE_WAKE, { agent: "sisyphus" }, true)
      await notifier.flushPendingParentWake(sessionID)

      // then
      expect(promptAsyncCalls).toHaveLength(2)
      expect(promptAsyncCalls[1]?.body.noReply).toBe(false)
      expect(notifier.getDispatchedParentWakes().get(sessionID)?.replyProduced).toBe(true)
      expect(notifier.getPendingParentWakes().has(sessionID)).toBe(false)
    } finally {
      notifier.shutdown()
      releaseAllPromptAsyncReservationsForTesting()
    }
  })
})
