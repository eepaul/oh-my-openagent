import { afterEach, describe, expect, it, mock } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setContinuationMarkerSource } from "../../features/run-continuation-state"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"
import { checkCompletionConditions } from "./completion"
import { classifyBoulderContinuation } from "./continuation-state"
import type { ChildSession, RunContext, SessionStatus, Todo } from "./types"

const testDirectories: string[] = []

function createTestDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "omo-waiting-classifier-"))
  testDirectories.push(directory)
  return directory
}

function createContext(input: {
  readonly directory: string
  readonly todos?: readonly Todo[]
  readonly children?: Record<string, readonly ChildSession[]>
  readonly statuses?: Record<string, SessionStatus>
}): RunContext {
  const { directory, todos = [], children = { "test-session": [] }, statuses = {} } = input
  return {
    client: unsafeTestValue<RunContext["client"]>({
      session: {
        todo: mock(async () => ({ data: todos })),
        children: mock(async ({ path }: { readonly path: { readonly id: string } }) => ({
          data: children[path.id] ?? [],
        })),
        status: mock(async () => ({ data: statuses })),
        get: mock(async ({ path }: { readonly path: { readonly id: string } }) => ({
          data: { id: path.id, parentID: path.id === "test-session" ? "root-session" : undefined },
        })),
        messages: mock(async ({ path }: { readonly path: { readonly id: string } }) => ({
          data: path.id === "test-session"
            ? [{ info: { agent: "sisyphus-junior", providerID: "openai", modelID: "gpt" } }]
            : [],
        })),
      },
    }),
    sessionID: "test-session",
    directory,
    abortController: new AbortController(),
  }
}

function writeBoulderFixture(input: {
  readonly directory: string
  readonly plan: string
  readonly sessionIds: readonly string[]
  readonly sessionOrigins?: Readonly<Record<string, "direct" | "appended">>
}): void {
  const { directory, plan, sessionIds, sessionOrigins } = input
  const planPath = join(directory, ".omo", "plans", "waiting-plan.md")
  mkdirSync(join(directory, ".omo", "plans"), { recursive: true })
  writeFileSync(planPath, plan)
  writeFileSync(join(directory, ".omo", "boulder.json"), JSON.stringify({
    active_plan: planPath,
    plan_name: "waiting-plan",
    agent: "atlas",
    started_at: "2026-07-29T00:00:00.000Z",
    session_ids: sessionIds,
    ...(sessionOrigins === undefined ? {} : { session_origins: sessionOrigins }),
  }))
}

afterEach(() => {
  while (testDirectories.length > 0) {
    const directory = testDirectories.pop()
    if (directory) rmSync(directory, { recursive: true, force: true })
  }
})

describe("waiting-on-human boulder continuation classification", () => {
  it("#given an untracked session #when its boulder plan is waiting #then it is not classified as waiting", async () => {
    // given
    const directory = createTestDirectory()
    writeBoulderFixture({
      directory,
      plan: "- [x] finished\n- [~] 2. needs approval\n",
      sessionIds: ["tracked-session"],
    })
    const ctx = createContext({ directory })

    // when
    const result = await classifyBoulderContinuation(directory, ctx.sessionID, ctx.client)

    // then
    expect(result).toBe("none")
  })

  it("#given an appended session with the wrong agent #when its boulder plan is waiting #then it is not classified as waiting", async () => {
    // given
    const directory = createTestDirectory()
    writeBoulderFixture({
      directory,
      plan: "- [x] finished\n- [~] 2. needs approval\n",
      sessionIds: ["root-session", "test-session"],
      sessionOrigins: { "root-session": "direct", "test-session": "appended" },
    })
    const ctx = createContext({ directory })

    // when
    const result = await classifyBoulderContinuation(directory, ctx.sessionID, ctx.client)

    // then
    expect(result).toBe("none")
  })

  it("#given a tracked session with unfinished normal tasks #when checking boulder continuation #then it remains active", async () => {
    // given
    const directory = createTestDirectory()
    writeBoulderFixture({ directory, plan: "- [ ] 1. continue\n", sessionIds: ["test-session"] })
    const ctx = createContext({ directory })

    // when
    const result = await classifyBoulderContinuation(directory, ctx.sessionID, ctx.client)

    // then
    expect(result).toBe("active")
  })

  it("#given a waiting boulder and an active background marker #when checking completion #then the run remains pending", async () => {
    // given
    const directory = createTestDirectory()
    writeBoulderFixture({
      directory,
      plan: "- [x] finished\n- [~] 2. needs approval\n",
      sessionIds: ["test-session"],
    })
    setContinuationMarkerSource(directory, "test-session", "background-task", "active", "background work")
    const ctx = createContext({ directory })

    // when
    const result = await checkCompletionConditions(ctx)

    // then
    expect(result).toBe("pending")
  })

  it("#given a waiting boulder and a busy child session #when checking completion #then the run remains pending", async () => {
    // given
    const directory = createTestDirectory()
    writeBoulderFixture({
      directory,
      plan: "- [x] finished\n- [~] 2. needs approval\n",
      sessionIds: ["test-session"],
    })
    const ctx = createContext({
      directory,
      children: { "test-session": [{ id: "child-session" }], "child-session": [] },
      statuses: { "child-session": { type: "busy" } },
    })

    // when
    const result = await checkCompletionConditions(ctx)

    // then
    expect(result).toBe("pending")
  })
})
