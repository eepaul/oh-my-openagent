/// <reference types="bun-types" />

import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from "bun:test"
import type { ClaudeHooksConfig } from "./types"
import type { PreToolUseContext } from "./pre-tool-use"
import * as dispatchHookModule from "./dispatch-hook"
import * as logger from "../../shared/logger"
import { clearAllApprovals, hasApproval, recordApproval } from "../../shared/external-directory-approvals"
import { executePreToolUseHooks } from "./pre-tool-use"

function createContext(overrides?: Partial<PreToolUseContext>): PreToolUseContext {
  return {
    sessionId: "test-session",
    toolName: "write",
    toolInput: { file_path: "/tmp/test.md", content: "hello" },
    cwd: "/tmp",
    ...overrides,
  }
}

function createConfig(matchers: ClaudeHooksConfig["PreToolUse"]): ClaudeHooksConfig {
  return { PreToolUse: matchers }
}

describe("executePreToolUseHooks", () => {
  let dispatchSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    clearAllApprovals()
    dispatchSpy = spyOn(dispatchHookModule, "dispatchHook")
    spyOn(logger, "log").mockImplementation(() => {})
  })

  afterEach(() => {
    mock.restore()
  })

  it("#given null config #when called #then returns allow", async () => {
    const result = await executePreToolUseHooks(createContext(), null)
    expect(result.decision).toBe("allow")
  })

  it("#given no matching hooks #when called #then returns allow", async () => {
    const config = createConfig([
      { matcher: "Bash", hooks: [{ type: "command", command: "echo test" }] },
    ])
    const result = await executePreToolUseHooks(createContext({ toolName: "write" }), config)
    expect(result.decision).toBe("allow")
  })

  it("#given hook returns exit code 2 #when called #then returns deny", async () => {
    dispatchSpy.mockResolvedValue({ exitCode: 2, stdout: "", stderr: "blocked" })

    const config = createConfig([
      { matcher: "Write", hooks: [{ type: "command", command: "echo deny" }] },
    ])
    const result = await executePreToolUseHooks(createContext(), config)

    expect(result.decision).toBe("deny")
    expect(result.reason).toBe("blocked")
  })

  it("#given hook deny reason with CRLF and bare CR #when called #then returns normalized reason", async () => {
    dispatchSpy.mockResolvedValue({
      exitCode: 2,
      stdout: "",
      stderr: "\r\nblocked line\r\n  detail\rfinal line\r\n",
    })

    const config = createConfig([
      { matcher: "Write", hooks: [{ type: "command", command: "echo deny" }] },
    ])
    const result = await executePreToolUseHooks(createContext(), config)

    expect(result.decision).toBe("deny")
    expect(result.reason).toBe("blocked line\n  detail\nfinal line")
  })

  it("#given hook returns exit code 1 #when called #then returns ask", async () => {
    dispatchSpy.mockResolvedValue({ exitCode: 1, stdout: "", stderr: "needs confirmation" })

    const config = createConfig([
      { matcher: "Write", hooks: [{ type: "command", command: "echo ask" }] },
    ])
    const result = await executePreToolUseHooks(createContext(), config)

    expect(result.decision).toBe("ask")
    expect(result.reason).toBe("needs confirmation")
  })

  it("#given external-directory approval is already recorded in the memo #when same child tool accesses it again #then only approved access is suppressed", async () => {
    //#given a child session hits the Claude-compatible external-directory ask hook
    dispatchSpy.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({
        hookSpecificOutput: {
          permissionDecision: "ask",
          permissionDecisionReason: "OpenCode needs approval for external_directory /tmp/approved-parent",
        },
      }),
      stderr: "",
    })
    const config = createConfig([
      { matcher: "Write", hooks: [{ type: "command", command: "node external-directory-guard.mjs" }] },
    ])
    const childExternalWrite = createContext({
      sessionId: "ses_child_from_ses_parent",
      toolName: "write",
      toolInput: { file_path: "/tmp/approved-parent/repro.md", content: "hello" },
      cwd: "/home/paul/projects/oh-my-openagent",
      permissionMode: "plan",
    })

    const firstResult = await executePreToolUseHooks(childExternalWrite, config)
    const secondResultBeforeApproval = await executePreToolUseHooks(childExternalWrite, config)

    //#when the external directory is recorded in the memo by an upstream production path
    recordApproval("ses_child_from_ses_parent", "/tmp/approved-parent")
    const thirdResultAfterApproval = await executePreToolUseHooks(childExternalWrite, config)
    const siblingExternalWrite = createContext({
      sessionId: "ses_child_from_ses_parent",
      toolName: "write",
      toolInput: { file_path: "/tmp/other-parent/repro.md", content: "hello" },
      cwd: "/home/paul/projects/oh-my-openagent",
      permissionMode: "plan",
    })
    const differentDirectoryResult = await executePreToolUseHooks(siblingExternalWrite, config)

    //#then asks do not create approval, but a memo approval suppresses the repeated same-directory ask only
    expect(firstResult.decision).toBe("ask")
    expect(secondResultBeforeApproval.decision).toBe("ask")
    expect(thirdResultAfterApproval.decision).toBe("allow")
    expect(differentDirectoryResult.decision).toBe("ask")
    expect(dispatchSpy).toHaveBeenCalledTimes(3)
  })

  it("#given internal external-directory ask #when the same directory asks again #then the synthetic turn is not recorded as approval", async () => {
    //#given an internal continuation triggers an external-directory ask
    dispatchSpy.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({
        hookSpecificOutput: {
          permissionDecision: "ask",
          permissionDecisionReason: "OpenCode needs approval for external_directory '/tmp/internal-parent'",
        },
      }),
      stderr: "",
    })
    const config = createConfig([
      { matcher: "Write", hooks: [{ type: "command", command: "node external-directory-guard.mjs" }] },
    ])
    const internalExternalWrite = createContext({
      sessionId: "ses_internal_external",
      toolName: "write",
      toolInput: { file_path: "/tmp/internal-parent/repro.md", content: "hello" },
      cwd: "/home/paul/projects/oh-my-openagent",
      internalInitiator: true,
    })

    //#when the same internal lineage repeats the request
    const firstResult = await executePreToolUseHooks(internalExternalWrite, config)
    const secondResult = await executePreToolUseHooks(internalExternalWrite, config)

    //#then no approval memo is created from the synthetic turn
    expect(firstResult.decision).toBe("ask")
    expect(secondResult.decision).toBe("ask")
    expect(hasApproval("ses_internal_external", "/tmp/internal-parent")).toBe(false)
    expect(dispatchSpy).toHaveBeenCalledTimes(2)
  })

  describe("#given multiple hooks with merged config (global + project)", () => {
    it("#when first hook allows and second hook denies #then returns deny", async () => {
      let callCount = 0
      dispatchSpy.mockImplementation(async () => {
        callCount++
        if (callCount === 1) {
          // Global catch-all hook returns "allow" via JSON
          return {
            exitCode: 0,
            stdout: JSON.stringify({ decision: "allow" }),
            stderr: "",
          }
        }
        // Project budget guard hook returns exit code 2 (deny)
        return { exitCode: 2, stdout: "", stderr: "BUDGET EXCEEDED" }
      })

      const config = createConfig([
        // Global catch-all (no specific matcher = matches everything)
        { matcher: "*", hooks: [{ type: "command", command: "node pre-tool-use.mjs" }] },
        // Project budget guard
        { matcher: "Edit|Write", hooks: [{ type: "command", command: "bash budget-guard.sh" }] },
      ])

      const result = await executePreToolUseHooks(createContext(), config)

      expect(callCount).toBe(2)
      expect(result.decision).toBe("deny")
      expect(result.reason).toBe("BUDGET EXCEEDED")
    })

    it("#when first hook allows and second hook also allows #then returns allow", async () => {
      let callCount = 0
      dispatchSpy.mockImplementation(async () => {
        callCount++
        if (callCount === 1) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({ decision: "allow" }),
            stderr: "",
          }
        }
        return { exitCode: 0, stdout: "", stderr: "" }
      })

      const config = createConfig([
        { matcher: "*", hooks: [{ type: "command", command: "node pre-tool-use.mjs" }] },
        { matcher: "Edit|Write", hooks: [{ type: "command", command: "bash budget-guard.sh" }] },
      ])

      const result = await executePreToolUseHooks(createContext(), config)

      expect(callCount).toBe(2)
      expect(result.decision).toBe("allow")
    })

    it("#when first hook denies #then second hook is NOT executed", async () => {
      let callCount = 0
      dispatchSpy.mockImplementation(async () => {
        callCount++
        return { exitCode: 2, stdout: "", stderr: "denied by first hook" }
      })

      const config = createConfig([
        { matcher: "*", hooks: [{ type: "command", command: "node pre-tool-use.mjs" }] },
        { matcher: "Edit|Write", hooks: [{ type: "command", command: "bash budget-guard.sh" }] },
      ])

      const result = await executePreToolUseHooks(createContext(), config)

      expect(callCount).toBe(1)
      expect(result.decision).toBe("deny")
    })

    it("#when first hook allows via JSON with modifiedInput #then input is passed to second hook", async () => {
      const capturedStdin: string[] = []
      let callCount = 0
      dispatchSpy.mockImplementation(async (_hook: unknown, stdinJson: string) => {
        capturedStdin.push(stdinJson)
        callCount++
        if (callCount === 1) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              decision: "allow",
            }),
            stderr: "",
          }
        }
        return { exitCode: 0, stdout: "", stderr: "" }
      })

      const config = createConfig([
        { matcher: "*", hooks: [{ type: "command", command: "node pre-tool-use.mjs" }] },
        { matcher: "Edit|Write", hooks: [{ type: "command", command: "bash budget-guard.sh" }] },
      ])

      await executePreToolUseHooks(createContext(), config)

      expect(callCount).toBe(2)
    })

    it("#when hook returns allow with updatedInput #then modifiedInput is included in final result", async () => {
      dispatchSpy.mockResolvedValue({
        exitCode: 0,
        stdout: JSON.stringify({
          decision: "allow",
          hookSpecificOutput: {
            permissionDecision: "allow",
            updatedInput: { file_path: "/tmp/modified.md" },
          },
        }),
        stderr: "",
      })

      const config = createConfig([
        { matcher: "Write", hooks: [{ type: "command", command: "bash modifier.sh" }] },
      ])

      const result = await executePreToolUseHooks(createContext(), config)

      expect(result.decision).toBe("allow")
      expect(result.modifiedInput).toEqual({ file_path: "/tmp/modified.md" })
    })

    it("#when hook returns allow with common fields #then fields are included in final result", async () => {
      dispatchSpy.mockResolvedValue({
        exitCode: 0,
        stdout: JSON.stringify({
          decision: "allow",
          suppressOutput: true,
          systemMessage: "Budget warning: approaching limit",
        }),
        stderr: "",
      })

      const config = createConfig([
        { matcher: "Write", hooks: [{ type: "command", command: "bash checker.sh" }] },
      ])

      const result = await executePreToolUseHooks(createContext(), config)

      expect(result.decision).toBe("allow")
      expect(result.suppressOutput).toBe(true)
      expect(result.systemMessage).toBe("Budget warning: approaching limit")
    })

    it("#when first hook allows with modifiedInput and second hook denies #then deny includes accumulated modifiedInput", async () => {
      let callCount = 0
      dispatchSpy.mockImplementation(async () => {
        callCount++
        if (callCount === 1) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              decision: "allow",
              hookSpecificOutput: {
                permissionDecision: "allow",
                updatedInput: { file_path: "/tmp/modified.md" },
              },
            }),
            stderr: "",
          }
        }
        return { exitCode: 2, stdout: "", stderr: "BUDGET EXCEEDED" }
      })

      const config = createConfig([
        { matcher: "*", hooks: [{ type: "command", command: "node modifier.mjs" }] },
        { matcher: "Edit|Write", hooks: [{ type: "command", command: "bash budget-guard.sh" }] },
      ])

      const result = await executePreToolUseHooks(createContext(), config)

      expect(callCount).toBe(2)
      expect(result.decision).toBe("deny")
      expect(result.modifiedInput).toEqual({ file_path: "/tmp/modified.md" })
    })
  })
})
