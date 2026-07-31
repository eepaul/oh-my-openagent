import { afterEach, describe, expect, it, mock } from "bun:test"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { enterWaitingOnHuman, resumeFromHuman } from "@oh-my-opencode/boulder-state"
import {
  createBoulderState,
  readBoulderState,
  writeBoulderState,
} from "../../features/boulder-state"
import {
  armFailClosed,
  currentResumeEpoch,
  isFailClosed,
  resetWaitingFailClosedGateForTesting,
  runPromotion,
} from "../shared/waiting-fail-closed-gate"
import { buildWorkResumeRetryContext } from "./context-info-formatters"
import { selectWorkForStartWork } from "./selected-work-resume"

const testDirectories: string[] = []

function createTestDirectory(): string {
  const directory = join(tmpdir(), `omo-selected-work-resume-${randomUUID()}`)
  mkdirSync(directory, { recursive: true })
  testDirectories.push(directory)
  return directory
}

function createWaitingWork(input: {
  readonly directory: string
  readonly planName: string
  readonly reason: string
  readonly since: string
}): { readonly planPath: string; readonly workId: string } {
  const planPath = join(input.directory, ".omo", "plans", `${input.planName}.md`)
  mkdirSync(join(input.directory, ".omo", "plans"), { recursive: true })
  writeFileSync(planPath, "## TODOs\n- [~] 1. needs approval\n")
  const state = createBoulderState(planPath, "prior-session", "atlas", undefined)
  const workId = state.active_work_id
  if (!workId) throw new Error("expected active work id")
  const work = state.works?.[workId]
  if (!work) throw new Error("expected active work")
  const waiting = { reason: input.reason, since: input.since, source: "plan-blocked" } as const
  expect(writeBoulderState(input.directory, {
    ...state,
    status: "waiting_on_human",
    waiting,
    works: { ...state.works, [workId]: { ...work, status: "waiting_on_human", waiting } },
  })).toBe(true)
  return { planPath, workId }
}

function replaceWaitingEpisode(input: {
  readonly directory: string
  readonly workId: string
  readonly reason: string
  readonly since: string
}): void {
  const state = readBoulderState(input.directory)
  const work = state?.works?.[input.workId]
  if (!state || !work) throw new Error("expected waiting work")
  const waiting = { reason: input.reason, since: input.since, source: "plan-blocked" } as const
  expect(writeBoulderState(input.directory, {
    ...state,
    status: "waiting_on_human",
    waiting,
    works: { ...state.works, [input.workId]: { ...work, status: "waiting_on_human", waiting } },
  })).toBe(true)
}

afterEach(() => {
  resetWaitingFailClosedGateForTesting()
  while (testDirectories.length > 0) {
    const directory = testDirectories.pop()
    if (directory && existsSync(directory)) rmSync(directory, { recursive: true, force: true })
  }
})

describe("start-work selected waiting work resume", () => {
  it("#given a resume write failure #when selecting waiting work #then it remains waiting and yields a retryable non-resumed context", async () => {
    // given
    const directory = createTestDirectory()
    const { workId } = createWaitingWork({
      directory,
      planName: "write-failure",
      reason: "approval is required",
      since: "2026-07-31T00:00:00.000Z",
    })
    const resume = mock(() => false)

    // when
    const result = await selectWorkForStartWork({ directory, workId }, { resumeFromHuman: resume })
    const context = result.kind === "retryable-error"
      ? buildWorkResumeRetryContext({ planName: "write-failure", reason: result.reason })
      : ""

    // then
    expect(result).toEqual({ kind: "retryable-error", reason: "resume-write-failed" })
    expect(resume).toHaveBeenCalledTimes(1)
    expect(readBoulderState(directory)?.status).toBe("waiting_on_human")
    expect(context).toContain('retryable="true"')
    expect(context).not.toContain("RESUMING existing work")
  })

  it("#given an old promotion writes before the human record #when selection waits for its serializer tail #then the human resume overwrites waiting", async () => {
    // given
    const directory = createTestDirectory()
    const { planPath, workId } = createWaitingWork({
      directory,
      planName: "old-before-record",
      reason: "approval is required",
      since: "2026-07-31T00:00:00.000Z",
    })
    expect(resumeFromHuman(directory, workId)).toBe(true)
    const promotionFinishedWriting = Promise.withResolvers<void>()
    const releasePromotion = Promise.withResolvers<void>()
    const promotion = runPromotion(directory, workId, currentResumeEpoch(directory, workId), async () => {
      expect(enterWaitingOnHuman(directory, workId, { reason: "approval is required", source: "plan-blocked" })).toBe(true)
      replaceWaitingEpisode({
        directory,
        workId,
        reason: "approval is required",
        since: "2026-07-31T00:00:01.000Z",
      })
      promotionFinishedWriting.resolve()
      await releasePromotion.promise
      return { meta: { source: "plan-blocked" }, persisted: true }
    })
    await promotionFinishedWriting.promise

    // when
    const selection = selectWorkForStartWork({ directory, workId })
    releasePromotion.resolve()
    const [promoted, result] = await Promise.all([promotion, selection])

    // then
    expect(promoted).toBe(true)
    expect(result).toMatchObject({ kind: "selected", resumedFromHuman: true })
    expect(readBoulderState(directory)?.active_plan).toBe(planPath)
    expect(readBoulderState(directory)?.status).toBe("active")
    expect(readBoulderState(directory)?.waiting).toBeUndefined()
  })

  it("#given an old promotion starts after the human record #when it enters the serializer #then its old epoch CAS fails", async () => {
    // given
    const directory = createTestDirectory()
    const { workId } = createWaitingWork({
      directory,
      planName: "old-after-record",
      reason: "approval is required",
      since: "2026-07-31T00:00:00.000Z",
    })
    expect(resumeFromHuman(directory, workId)).toBe(true)
    const oldEpoch = currentResumeEpoch(directory, workId)

    // when
    const selection = selectWorkForStartWork({ directory, workId })
    const promotion = runPromotion(directory, workId, oldEpoch, async () => {
      expect(enterWaitingOnHuman(directory, workId, { reason: "late approval", source: "plan-blocked" })).toBe(true)
      return { meta: { source: "plan-blocked" }, persisted: true }
    })
    const [result, promoted] = await Promise.all([selection, promotion])

    // then
    expect(result).toMatchObject({ kind: "selected", resumedFromHuman: false })
    expect(promoted).toBe(false)
    expect(readBoulderState(directory)?.status).toBe("active")
  })

  it("#given a new waiting episode queues between record and resume #when selection revalidates #then it leaves the newer episode untouched", async () => {
    // given
    const directory = createTestDirectory()
    const { workId } = createWaitingWork({
      directory,
      planName: "new-between-record-and-resume",
      reason: "old approval is required",
      since: "2026-07-31T00:00:00.000Z",
    })
    const resume = mock(() => true)
    const nextEpoch = currentResumeEpoch(directory, workId) + 1

    // when
    const selection = selectWorkForStartWork({ directory, workId }, { resumeFromHuman: resume })
    const promotion = runPromotion(directory, workId, nextEpoch, async () => {
      expect(resumeFromHuman(directory, workId)).toBe(true)
      expect(enterWaitingOnHuman(directory, workId, { reason: "new approval is required", source: "plan-blocked" })).toBe(true)
      replaceWaitingEpisode({
        directory,
        workId,
        reason: "new approval is required",
        since: "2026-07-31T00:00:02.000Z",
      })
      return { meta: { source: "plan-blocked" }, persisted: true }
    })
    const [result, promoted] = await Promise.all([selection, promotion])
    const persisted = readBoulderState(directory)

    // then
    expect(promoted).toBe(true)
    expect(result).toEqual({ kind: "retryable-error", reason: "newer-waiting-episode" })
    expect(resume).not.toHaveBeenCalled()
    expect(persisted?.status).toBe("waiting_on_human")
    expect(persisted?.waiting?.reason).toBe("new approval is required")
    expect(persisted?.waiting?.since).toBe("2026-07-31T00:00:02.000Z")
  })

  it("#given an active work has a residual failure gate #when selected #then record clears the gate", async () => {
    // given
    const directory = createTestDirectory()
    const { workId } = createWaitingWork({
      directory,
      planName: "residual-gate",
      reason: "approval is required",
      since: "2026-07-31T00:00:00.000Z",
    })
    expect(resumeFromHuman(directory, workId)).toBe(true)
    await armFailClosed(directory, workId, { source: "plan-blocked" })

    // when
    const result = await selectWorkForStartWork({ directory, workId })

    // then
    expect(result).toMatchObject({ kind: "selected", resumedFromHuman: false })
    expect(isFailClosed(directory, workId)).toBe(false)
  })
})
