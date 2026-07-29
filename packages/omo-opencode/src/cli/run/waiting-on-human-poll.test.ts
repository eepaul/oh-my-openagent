import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"
import { createEventState } from "./events"
import { pollForCompletion } from "./poll-for-completion"
import type { RunContext, Todo } from "./types"

const testDirectories: string[] = []

function createTestDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "omo-waiting-poll-"))
  testDirectories.push(directory)
  return directory
}

function createContext(directory: string, todos: readonly Todo[]): RunContext {
  return {
    client: unsafeTestValue<RunContext["client"]>({
      session: {
        todo: mock(async () => ({ data: todos })),
        children: mock(async () => ({ data: [] })),
        status: mock(async () => ({ data: {} })),
      },
    }),
    sessionID: "test-session",
    directory,
    abortController: new AbortController(),
  }
}

function writeBoulderFixture(directory: string, plan: string): void {
  const planPath = join(directory, ".omo", "plans", "waiting-plan.md")
  mkdirSync(join(directory, ".omo", "plans"), { recursive: true })
  writeFileSync(planPath, plan)
  writeFileSync(join(directory, ".omo", "boulder.json"), JSON.stringify({
    active_plan: planPath,
    plan_name: "waiting-plan",
    agent: "atlas",
    started_at: "2026-07-29T00:00:00.000Z",
    session_ids: ["test-session"],
  }))
}

function createClock(onSleep?: (elapsed: number) => void): {
  readonly now: () => number
  readonly sleep: (ms: number) => Promise<void>
} {
  let elapsed = 0
  return {
    now: () => elapsed,
    sleep: async (ms) => {
      elapsed += ms
      onSleep?.(elapsed)
    },
  }
}

afterEach(() => {
  while (testDirectories.length > 0) {
    const directory = testDirectories.pop()
    if (directory) rmSync(directory, { recursive: true, force: true })
  }
})

describe("waiting-on-human CLI run completion", () => {
  it("#given a waiting plan and incomplete session todos #when polling #then it reports waiting and exits successfully", async () => {
    // given
    const directory = createTestDirectory()
    writeBoulderFixture(directory, "- [x] finished\n- [~] 2. needs approval\n")
    const ctx = createContext(directory, [{ id: "todo", content: "pending", status: "pending", priority: "high" }])
    const eventState = createEventState()
    eventState.mainSessionIdle = true
    eventState.hasReceivedMeaningfulWork = true
    const logSpy = spyOn(console, "log").mockImplementation(() => {})
    const abortController = new AbortController()
    const clock = createClock((elapsed) => {
      if (elapsed >= 20) abortController.abort()
    })

    // when
    const exitCode = await pollForCompletion(ctx, eventState, abortController, {
      pollIntervalMs: 1,
      minStabilizationMs: 1,
      now: clock.now,
      sleep: clock.sleep,
    })

    // then
    const output = logSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n")
    expect(exitCode).toBe(0)
    expect(output).toContain('Plan "waiting-plan" is waiting on a human decision (1 task(s) marked [~]).')
    expect(output).not.toContain("All tasks completed.")
    logSpy.mockRestore()
  })

  it("#given a truly complete plan #when polling #then it preserves the completed output", async () => {
    // given
    const directory = createTestDirectory()
    writeBoulderFixture(directory, "- [x] 1. finished\n")
    const ctx = createContext(directory, [])
    const eventState = createEventState()
    eventState.mainSessionIdle = true
    eventState.hasReceivedMeaningfulWork = true
    const logSpy = spyOn(console, "log").mockImplementation(() => {})
    const abortController = new AbortController()
    const clock = createClock((elapsed) => {
      if (elapsed >= 20) abortController.abort()
    })

    // when
    const exitCode = await pollForCompletion(ctx, eventState, abortController, {
      pollIntervalMs: 1,
      minStabilizationMs: 1,
      now: clock.now,
      sleep: clock.sleep,
    })

    // then
    const output = logSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n")
    expect(exitCode).toBe(0)
    expect(output).toContain("All tasks completed.")
    logSpy.mockRestore()
  })
})
