import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test"
import {
  clearCommentCheckerTestMocks,
  initializeCommentCheckerCli,
  startPendingCallCleanup,
} from "./comment-checker-test-mocks"

afterAll(() => {
  mock.restore()
})

const { createCommentCheckerHooks } = await import("./hook")

describe("comment-checker lazy initialization", () => {
  beforeEach(() => {
    clearCommentCheckerTestMocks()
  })

  it("initializes CLI and cleanup on first tool hook call only", async () => {
    // given
    const hooks = createCommentCheckerHooks()
    const beforeHook = hooks["tool.execute.before"]
    const input = { tool: "write", sessionID: "ses_test", callID: "call_test" }
    const output = { args: { filePath: "src/a.ts" } }

    // when
    expect(startPendingCallCleanup).toHaveBeenCalledTimes(0)
    expect(initializeCommentCheckerCli).toHaveBeenCalledTimes(0)

    // then
    await beforeHook(input, output)
    expect(startPendingCallCleanup).toHaveBeenCalledTimes(1)
    expect(initializeCommentCheckerCli).toHaveBeenCalledTimes(1)

    // when
    await beforeHook(input, output)

    // then
    expect(startPendingCallCleanup).toHaveBeenCalledTimes(1)
    expect(initializeCommentCheckerCli).toHaveBeenCalledTimes(1)
  })
})
