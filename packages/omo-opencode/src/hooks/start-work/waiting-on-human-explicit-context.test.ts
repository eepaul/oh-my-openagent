import { afterEach, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { archiveBoulderState, enterWaitingOnHuman } from "@oh-my-opencode/boulder-state"
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

async function buildExplicit(directory: string, explicitPlanName: string, sessionId: string): Promise<string> {
  return await buildExplicitPlanContext({
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
  it("#given an existing waiting work #when explicitly selecting it #then it resumes, clears waiting, and guides [~] reclassification", async () => {
    // given
    const directory = createTestDirectory()
    const planPath = writeWaitingPlan(directory, "existing")
    writeBoulderState(directory, createBoulderState(planPath, "prior-session", "atlas", undefined))
    const workId = readBoulderState(directory)?.active_work_id
    if (!workId) throw new Error("expected active work id")
    expect(enterWaitingOnHuman(directory, workId, {
      reason: "approval is required",
      source: "plan-blocked",
    })).toBe(true)

    // when
    const context = await buildExplicit(directory, "existing", "current-session")
    const persisted = readBoulderState(directory)

    // then
    expect(context).toContain("[~]")
    expect(context).toContain("[ ]")
    expect(context).not.toContain("Plan Already Complete")
    expect(persisted?.status).toBe("active")
    expect(persisted?.waiting).toBeUndefined()
    expect(persisted?.session_ids).toContain("opencode:current-session")
  })

  it("#given one waiting plan after an explicit miss #when selecting a plan #then fallback initializes and binds it", async () => {
    // given
    const directory = createTestDirectory()
    writeWaitingPlan(directory, "only-waiting")

    // when
    const context = await buildExplicit(directory, "missing", "current-session")

    // then
    expect(context).toContain("only-waiting")
    expect(context).toContain("waiting on human decision (1 task(s) marked [~])")
    expect(readBoulderState(directory)?.session_ids).toContain("opencode:current-session")
  })

  it("#given a directly matched waiting plan #when selecting it #then it creates a resumable work instead of completing it", async () => {
    // given
    const directory = createTestDirectory()
    writeWaitingPlan(directory, "matched")

    // when
    const context = await buildExplicit(directory, "matched", "current-session")

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

  it("#given archived waiting work restored to boulder.json #when explicitly starting it #then start-work rebinds the current session", async () => {
    // given
    const directory = createTestDirectory()
    const planPath = writeWaitingPlan(directory, "restored")
    writeBoulderState(directory, createBoulderState(planPath, "prior-session", "atlas", undefined))
    const workId = readBoulderState(directory)?.active_work_id
    if (!workId) throw new Error("expected active work id")
    expect(enterWaitingOnHuman(directory, workId, {
      reason: "approval is required",
      source: "plan-blocked",
    })).toBe(true)
    const archivedPath = archiveBoulderState(directory, () => new Date("2026-07-29T00:00:00.000Z"))
    if (!archivedPath) throw new Error("expected archived boulder state")
    renameSync(archivedPath, getBoulderFilePath(directory))

    // when
    const context = await buildExplicit(directory, "restored", "current-session")

    // then
    expect(context).not.toContain("Plan Already Complete")
    expect(context).toContain("waiting on human decision (1 task(s) marked [~])")
    expect(readBoulderState(directory)?.status).toBe("active")
    expect(readBoulderState(directory)?.waiting).toBeUndefined()
    expect(readBoulderState(directory)?.session_ids).toContain("opencode:current-session")
  })
})
