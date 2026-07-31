/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test"

import {
  QUESTION_TOOL_NAMES,
  latestAssistantTurnPendingQuestionTool,
} from "@oh-my-opencode/utils"
import { OMO_INTERNAL_INITIATOR_MARKER } from "../../shared/internal-initiator-marker"
import { hasUnansweredQuestion } from "./pending-question-detection"

describe("hasUnansweredQuestion", () => {
  test("given empty messages, returns false", () => {
    expect(hasUnansweredQuestion([])).toBe(false)
  })

  test("given null-ish input, returns false", () => {
    expect(hasUnansweredQuestion(undefined as never)).toBe(false)
  })

  test("given last assistant message with question tool_use, returns true", () => {
    const messages = [
      { info: { role: "user" } },
      {
        info: { role: "assistant" },
        parts: [
          { type: "tool_use", name: "question" },
        ],
      },
    ]
    expect(hasUnansweredQuestion(messages)).toBe(true)
  })

  test("given last assistant message with question tool-invocation, returns true", () => {
    const messages = [
      { info: { role: "user" } },
      {
        info: { role: "assistant" },
        parts: [
          { type: "tool-invocation", toolName: "question" },
        ],
      },
    ]
    expect(hasUnansweredQuestion(messages)).toBe(true)
  })

  test("#given last assistant message with OpenCode question tool field #when checking pending question #then returns true", () => {
    const messages = [
      { info: { role: "user" } },
      {
        info: { role: "assistant" },
        parts: [
          { type: "tool", tool: "question" },
        ],
      },
    ]
    expect(hasUnansweredQuestion(messages)).toBe(true)
  })

  test("#given last assistant message with OpenCode ask_user_question tool field #when checking pending question #then returns true", () => {
    const messages = [
      { info: { role: "user" } },
      {
        info: { role: "assistant" },
        parts: [
          { type: "tool", tool: "ask_user_question" },
        ],
      },
    ]
    expect(hasUnansweredQuestion(messages)).toBe(true)
  })

  test("#given completed OpenCode question tool #when checking pending question #then returns false", () => {
    const messages = [
      {
        info: { role: "assistant" },
        parts: [
          { type: "tool", tool: "question", state: { status: "completed" } },
        ],
      },
    ]
    expect(hasUnansweredQuestion(messages)).toBe(false)
  })

  test("given user message after question (answered), returns false", () => {
    const messages = [
      {
        info: { role: "assistant" },
        parts: [
          { type: "tool_use", name: "question" },
        ],
      },
      { info: { role: "user" } },
    ]
    expect(hasUnansweredQuestion(messages)).toBe(false)
  })

  test("given synthetic user message after question, still treats question as unanswered", () => {
    const messages = [
      {
        info: { role: "assistant" },
        parts: [
          { type: "tool_use", name: "question" },
        ],
      },
      {
        info: { role: "user" },
        parts: [
          { type: "text", text: "internal continuation", synthetic: true },
        ],
      },
    ]
    expect(hasUnansweredQuestion(messages)).toBe(true)
  })

  test("given internally marked user message after question, still treats question as unanswered", () => {
    const messages = [
      {
        info: { role: "assistant" },
        parts: [
          { type: "tool_use", name: "question" },
        ],
      },
      {
        info: { role: "user" },
        parts: [
          { type: "text", text: `internal continuation\n${OMO_INTERNAL_INITIATOR_MARKER}` },
        ],
      },
    ]
    expect(hasUnansweredQuestion(messages)).toBe(true)
  })

  test("given assistant message with non-question tool, returns false", () => {
    const messages = [
      { info: { role: "user" } },
      {
        info: { role: "assistant" },
        parts: [
          { type: "tool_use", name: "bash" },
        ],
      },
    ]
    expect(hasUnansweredQuestion(messages)).toBe(false)
  })

  test("given assistant message with no parts, returns false", () => {
    const messages = [
      { info: { role: "user" } },
      { info: { role: "assistant" } },
    ]
    expect(hasUnansweredQuestion(messages)).toBe(false)
  })

  test("given role on message directly (not in info), returns true for question", () => {
    const messages = [
      { role: "user" },
      {
        role: "assistant",
        parts: [
          { type: "tool_use", name: "question" },
        ],
      },
    ]
    expect(hasUnansweredQuestion(messages)).toBe(true)
  })

  test("given mixed tools including question, returns true", () => {
    const messages = [
      {
        info: { role: "assistant" },
        parts: [
          { type: "tool_use", name: "bash" },
          { type: "tool_use", name: "question" },
        ],
      },
    ]
    expect(hasUnansweredQuestion(messages)).toBe(true)
  })

  for (const toolName of QUESTION_TOOL_NAMES) {
    test(`#given ${toolName} #when both question consumers inspect the last assistant turn #then both cover the shared question tool set`, () => {
      // given
      const messages = [{
        info: { role: "assistant" },
        parts: [{
          type: "tool",
          callID: "call-shared-question-tool",
          tool: toolName,
          state: { status: "pending" },
        }],
      }]

      // when
      const enforcerDetected = hasUnansweredQuestion(messages)
      const atlasDetected = latestAssistantTurnPendingQuestionTool(messages)

      // then
      expect(enforcerDetected).toBeTrue()
      expect(atlasDetected?.callID).toBe("call-shared-question-tool")
    })
  }
})
