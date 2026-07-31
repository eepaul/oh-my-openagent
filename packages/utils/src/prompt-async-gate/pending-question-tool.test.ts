import { describe, expect, test } from "bun:test"

import { latestAssistantTurnPendingQuestionTool } from "./pending-tool-turn"

describe("latestAssistantTurnPendingQuestionTool", () => {
  for (const status of [undefined, "pending", "running", "in_progress"] as const) {
    test(`#given a ${status ?? "missing"} question status #when detecting the latest assistant turn #then it returns the stable call ID`, () => {
      // given
      const messages = [{
        info: { role: "assistant" },
        parts: [{
          type: "tool",
          id: "part-id-is-not-call-id",
          callID: "call-stable-question",
          tool: "question",
          ...(status === undefined ? {} : { state: { status } }),
        }],
      }]

      // when
      const detected = latestAssistantTurnPendingQuestionTool(messages)

      // then
      expect(detected?.callID).toBe("call-stable-question")
    })
  }

  for (const status of ["completed", "error", "cancelled", "denied"] as const) {
    test(`#given a ${status} question status #when detecting the latest assistant turn #then it does not promote a human wait`, () => {
      // given
      const messages = [{
        info: { role: "assistant" },
        parts: [{
          type: "tool",
          callID: "call-terminal-question",
          tool: "question",
          state: { status },
        }],
      }]

      // when
      const detected = latestAssistantTurnPendingQuestionTool(messages)

      // then
      expect(detected).toBeNull()
    })
  }
})
