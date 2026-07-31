import { afterEach, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { enterWaitingOnHuman } from "@oh-my-opencode/boulder-state"
import {
  createBoulderState,
  getWorkResumeOptions,
  readBoulderState,
  writeBoulderState,
} from "../../features/boulder-state"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"
import { buildStartWorkContextInfo } from "./context-info-builder"
import { buildExistingSessionContext, buildMultipleActiveWorksContext } from "./context-info-formatters"
import {
  buildPlanDiscoveryContext,
  shouldResumeExistingState,
  shouldResumeSingleWorkOption,
} from "./plan-discovery-context"
import { buildMissingPlanContext } from "./plan-selection"

const testDirectories: string[] = []

function createTestDirectory(): string {
  const directory = join(tmpdir(), `omo-waiting-discovery-${randomUUID()}`)
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

function createPluginInput(directory: string): Parameters<typeof buildStartWorkContextInfo>[0]["ctx"] {
  return unsafeTestValue<Parameters<typeof buildStartWorkContextInfo>[0]["ctx"]>({ directory })
}

afterEach(() => {
  while (testDirectories.length > 0) {
    const directory = testDirectories.pop()
    if (directory && existsSync(directory)) rmSync(directory, { recursive: true, force: true })
  }
})

describe("start-work waiting-on-human plan discovery", () => {
  it("#given an existing waiting plan #when checking whether to resume #then it remains eligible", () => {
    // given
    const directory = createTestDirectory()
    const planPath = writeWaitingPlan(directory, "existing")
    const state = createBoulderState(planPath, "prior-session", "atlas", undefined)

    // when
    const result = shouldResumeExistingState({ existingState: state, preferredPlanPath: null })

    // then
    expect(result).toBe(true)
  })

  it("#given a waiting preferred plan #when choosing a single active work #then it does not override that preferred plan", () => {
    // given
    const directory = createTestDirectory()
    const activePlanPath = writeWaitingPlan(directory, "active")
    const preferredPlanPath = writeWaitingPlan(directory, "preferred")
    writeBoulderState(directory, createBoulderState(activePlanPath, "prior-session", "atlas", undefined))
    const option = getWorkResumeOptions(directory)[0]
    if (!option) throw new Error("expected active work option")

    // when
    const result = shouldResumeSingleWorkOption({ directory, option, preferredPlanPath })

    // then
    expect(result).toBe(false)
  })

  it("#given a preferred waiting plan #when discovering plans #then it is selected and bound to the current session", () => {
    // given
    const directory = createTestDirectory()
    writeWaitingPlan(directory, "other")
    const preferredPlanPath = writeWaitingPlan(directory, "preferred")

    // when
    const context = buildPlanDiscoveryContext({
      contextInfo: "",
      sessionId: "current-session",
      timestamp: "2026-07-29T00:00:00.000Z",
      activeAgent: "atlas",
      worktreePath: undefined,
      worktreeBlock: "",
      directory,
      preferredPlanPath,
    })

    // then
    expect(context).toContain("preferred")
    expect(context).toContain("waiting on human decision (1 task(s) marked [~])")
    expect(readBoulderState(directory)?.session_ids).toContain("opencode:current-session")
  })

  it("#given an existing waiting work #when building its resume context #then it appends the current session instead of reporting completion", () => {
    // given
    const directory = createTestDirectory()
    const planPath = writeWaitingPlan(directory, "resume")
    const state = createBoulderState(planPath, "prior-session", "atlas", undefined)
    writeBoulderState(directory, state)

    // when
    const context = buildExistingSessionContext({
      existingState: state,
      sessionId: "current-session",
      activeAgent: "atlas",
      worktreePath: undefined,
      worktreeBlock: "",
      directory,
    })

    // then
    expect(context).toContain("waiting on human decision (1 task(s) marked [~])")
    expect(context).not.toContain("Previous Work Complete")
    expect(readBoulderState(directory)?.session_ids).toContain("opencode:current-session")
  })

  it("#given one persisted waiting work #when automatically selecting the sole resume option #then it becomes active", async () => {
    // given
    const directory = createTestDirectory()
    const planPath = writeWaitingPlan(directory, "sole-waiting")
    writeBoulderState(directory, createBoulderState(planPath, "prior-session", "atlas", undefined))
    const workId = readBoulderState(directory)?.active_work_id
    if (!workId) throw new Error("expected active work id")
    expect(enterWaitingOnHuman(directory, workId, {
      reason: "approval is required",
      source: "plan-blocked",
    })).toBe(true)

    // when
    await buildStartWorkContextInfo({
      ctx: createPluginInput(directory),
      explicitPlanName: null,
      existingState: readBoulderState(directory),
      sessionId: "current-session",
      timestamp: "2026-07-29T00:00:00.000Z",
      activeAgent: "atlas",
      worktreePath: undefined,
      worktreeBlock: "",
    })
    const persisted = readBoulderState(directory)

    // then
    expect(persisted?.status).toBe("active")
    expect(persisted?.waiting).toBeUndefined()
  })

  it("#given a persisted waiting reason and blocked plan #when formatting resume choices #then persisted reason takes priority in every label", () => {
    // given
    const directory = createTestDirectory()
    const planPath = writeWaitingPlan(directory, "reason-priority")
    writeBoulderState(directory, createBoulderState(planPath, "prior-session", "atlas", undefined))
    const workId = readBoulderState(directory)?.active_work_id
    if (!workId) throw new Error("expected active work id")
    expect(enterWaitingOnHuman(directory, workId, {
      reason: "approval is required",
      source: "plan-blocked",
    })).toBe(true)
    const option = getWorkResumeOptions(directory)[0]
    if (!option) throw new Error("expected resume option")

    // when
    const resumeContext = buildMultipleActiveWorksContext({
      resumeOptions: [option],
      sessionId: "current-session",
      timestamp: "2026-07-31T00:00:00.000Z",
    })
    const planContext = buildMissingPlanContext("missing", [planPath], [option])

    // then
    expect(resumeContext).toContain("approval is required")
    expect(planContext).toContain("approval is required")
  })

  it("#given unrelated waiting state and another preferred plan #when building start-work context #then it treats the waiting state as live", async () => {
    // given
    const directory = createTestDirectory()
    const waitingPlanPath = writeWaitingPlan(directory, "waiting")
    const preferredPlanPath = writeWaitingPlan(directory, "preferred")
    const state = createBoulderState(waitingPlanPath, "prior-session", "atlas", undefined)
    writeBoulderState(directory, state)
    // when
    const context = await buildStartWorkContextInfo({
      ctx: createPluginInput(directory),
      explicitPlanName: null,
      existingState: state,
      sessionId: "current-session",
      timestamp: "2026-07-29T00:00:00.000Z",
      activeAgent: "atlas",
      worktreePath: undefined,
      worktreeBlock: "",
      preferredPlanPath,
    })

    // then
    expect(context).toContain("preferred")
  })
})
