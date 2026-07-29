import { afterEach, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { archiveBoulderState } from "@oh-my-opencode/boulder-state"
import {
  createBoulderState,
  getBoulderFilePath,
  readBoulderState,
  writeBoulderState,
} from "../../features/boulder-state"
import { buildExplicitPlanContext } from "./explicit-plan-context"
import { buildMissingPlanContext } from "./plan-selection"

const testDirectories: string[] = []

function createTestDirectory(): string {
  const directory = join(tmpdir(), `omo-waiting-explicit-${randomUUID()}`)
  mkdirSync(directory, { recursive: true })
  testDirectories.push(directory)
  return directory
}

function writeWaitingPlan(directory: string, name: string): string {
  const planPath = join(directory, ".omo", "plans", `${name}.md`)
  mkdirSync(join(directory, ".omo", "plans"), { recursive: true })
  writeFileSync(planPath, "## TODOs\n- [x] 1. finished\n- [~] 2. needs approval\n")
  return planPath
}

function buildExplicit(directory: string, explicitPlanName: string, sessionId: string): string {
  return buildExplicitPlanContext({
    explicitPlanName,
    sessionId,
    timestamp: "2026-07-29T00:00:00.000Z",
    activeAgent: "atlas",
    worktreePath: undefined,
    worktreeBlock: "",
    directory,
  })
}

afterEach(() => {
  while (testDirectories.length > 0) {
    const directory = testDirectories.pop()
    if (directory) rmSync(directory, { recursive: true, force: true })
  }
})

describe("start-work waiting-on-human explicit plan paths", () => {
  it("#given an existing waiting work #when explicitly selecting it #then it resumes and binds the current session", () => {
    // given
    const directory = createTestDirectory()
    const planPath = writeWaitingPlan(directory, "existing")
    writeBoulderState(directory, createBoulderState(planPath, "prior-session", "atlas", undefined))

    // when
    const context = buildExplicit(directory, "existing", "current-session")

    // then
    expect(context).toContain("waiting on human decision (1 task(s) marked [~])")
    expect(context).not.toContain("Plan Already Complete")
    expect(readBoulderState(directory)?.session_ids).toContain("opencode:current-session")
  })

  it("#given one waiting plan after an explicit miss #when selecting a plan #then fallback initializes and binds it", () => {
    // given
    const directory = createTestDirectory()
    writeWaitingPlan(directory, "only-waiting")

    // when
    const context = buildExplicit(directory, "missing", "current-session")

    // then
    expect(context).toContain("only-waiting")
    expect(context).toContain("waiting on human decision (1 task(s) marked [~])")
    expect(readBoulderState(directory)?.session_ids).toContain("opencode:current-session")
  })

  it("#given a directly matched waiting plan #when selecting it #then it creates a resumable work instead of completing it", () => {
    // given
    const directory = createTestDirectory()
    writeWaitingPlan(directory, "matched")

    // when
    const context = buildExplicit(directory, "matched", "current-session")

    // then
    expect(context).toContain("matched")
    expect(context).toContain("waiting on human decision (1 task(s) marked [~])")
    expect(readBoulderState(directory)?.session_ids).toContain("opencode:current-session")
  })

  it("#given an explicit missing plan and a waiting candidate #when listing options #then the candidate remains visible as waiting", () => {
    // given
    const directory = createTestDirectory()
    const waitingPlanPath = writeWaitingPlan(directory, "candidate")

    // when
    const context = buildMissingPlanContext("missing", [waitingPlanPath])

    // then
    expect(context).toContain("candidate")
    expect(context).toContain("waiting on human decision (1 task(s) marked [~])")
  })

  it("#given archived waiting work restored to boulder.json #when explicitly starting it #then start-work rebinds the current session", () => {
    // given
    const directory = createTestDirectory()
    const planPath = writeWaitingPlan(directory, "restored")
    writeBoulderState(directory, createBoulderState(planPath, "prior-session", "atlas", undefined))
    const archivedPath = archiveBoulderState(directory, () => new Date("2026-07-29T00:00:00.000Z"))
    if (!archivedPath) throw new Error("expected archived boulder state")
    renameSync(archivedPath, getBoulderFilePath(directory))

    // when
    const context = buildExplicit(directory, "restored", "current-session")

    // then
    expect(context).not.toContain("Plan Already Complete")
    expect(context).toContain("waiting on human decision (1 task(s) marked [~])")
    expect(readBoulderState(directory)?.session_ids).toContain("opencode:current-session")
  })
})
