import { describe, expect, test } from "bun:test"
import { STOP_CONTINUATION_TEMPLATE } from "./stop-continuation"

describe("stop-continuation template", () => {
  test("should export a non-empty template string", () => {
    // given - the stop-continuation template

    // when - we access the template

    // then - it should be a non-empty string
    expect(typeof STOP_CONTINUATION_TEMPLATE).toBe("string")
    expect(STOP_CONTINUATION_TEMPLATE.length).toBeGreaterThan(0)
  })

  test("should describe the stop-continuation behavior", () => {
    // given - the stop-continuation template

    // when - we check the content

    // then - it should mention key behaviors
    expect(STOP_CONTINUATION_TEMPLATE).toContain("todo-continuation-enforcer")
    expect(STOP_CONTINUATION_TEMPLATE).toContain("Ralph Loop")
    expect(STOP_CONTINUATION_TEMPLATE).toContain("active Goal")
    expect(STOP_CONTINUATION_TEMPLATE).toContain("boulder state")
    expect(STOP_CONTINUATION_TEMPLATE).toContain("Archive the boulder state")
    expect(STOP_CONTINUATION_TEMPLATE).toContain("boulder.json.stopped-<timestamp>")
    expect(STOP_CONTINUATION_TEMPLATE).toContain("-2")
    expect(STOP_CONTINUATION_TEMPLATE).toContain("/start-work <plan-name>")
    expect(STOP_CONTINUATION_TEMPLATE).not.toContain("new session")
    expect(STOP_CONTINUATION_TEMPLATE).not.toContain("Clear the boulder state")
    expect(STOP_CONTINUATION_TEMPLATE).not.toContain("deleted")
  })
})
