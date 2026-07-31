import { describe, expect, test } from "bun:test"

import { isResumableHumanInput } from "./resumable-human-input"

describe("isResumableHumanInput", () => {
  test("#given a real non-command user text part #when compaction grace is inactive #then it is resumable", () => {
    // given
    const message = {
      info: { role: "user" },
      parts: [{ type: "text", text: "The API token is ready." }],
    }

    // when
    const resumable = isResumableHumanInput(message, { compactionGraceActive: false })

    // then
    expect(resumable).toBeTrue()
  })

  test("#given an internally initiated text part #when it arrives as a user message #then it is not resumable", () => {
    // given
    const message = {
      info: { role: "user" },
      parts: [{ type: "text", text: "continue <!-- OMO_INTERNAL_INITIATOR -->" }],
    }

    // when
    const resumable = isResumableHumanInput(message, { compactionGraceActive: false })

    // then
    expect(resumable).toBeFalse()
  })

  test("#given any leading slash command #when it reaches either message observer #then it is not resumable", () => {
    // given
    const commands = ["/stop-continuation", "/start-work plan", "/other"]

    // when
    const resumable = commands.map((text) => isResumableHumanInput({
      info: { role: "user" },
      parts: [{ type: "text", text: `  ${text}` }],
    }, { compactionGraceActive: false }))

    // then
    expect(resumable).toEqual([false, false, false])
  })

  test("#given a real answer after a synthetic context part #when the first real text is examined #then it remains resumable", () => {
    // given
    const message = {
      info: { role: "user" },
      parts: [
        { type: "text", text: "internal context", synthetic: true },
        { type: "text", text: "Use the staging account." },
      ],
    }

    // when
    const resumable = isResumableHumanInput(message, { compactionGraceActive: false })

    // then
    expect(resumable).toBeTrue()
  })

  test("#given a real answer during compaction grace #when it is classified #then it is not resumable", () => {
    // given
    const message = {
      info: { role: "user" },
      parts: [{ type: "text", text: "Proceed." }],
    }

    // when
    const resumable = isResumableHumanInput(message, { compactionGraceActive: true })

    // then
    expect(resumable).toBeFalse()
  })
})
