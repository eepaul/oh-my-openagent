/// <reference path="../../../bun-test.d.ts" />

import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { checkPlanWaiting } from "./index"
import type { BoulderWaitingMetadata, BoulderWorkState, BoulderWorkStatus } from "./types"

const cleanupRoots: string[] = []
const planPath = ".omo/plans/waiting.md"
const boulderPath = ".omo/boulder.json"

function createTempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "boulder-waiting-work-"))
  cleanupRoots.push(directory)
  return directory
}

function writePlan(directory: string, markdown: string): void {
  const absolutePlanPath = join(directory, planPath)
  mkdirSync(join(directory, ".omo", "plans"), { recursive: true })
  writeFileSync(absolutePlanPath, markdown, "utf-8")
}

function writeRawState(directory: string, work: BoulderWorkState): void {
  mkdirSync(join(directory, ".omo"), { recursive: true })
  writeFileSync(
    join(directory, boulderPath),
    JSON.stringify({
      schema_version: 2,
      active_work_id: work.work_id,
      active_plan: work.active_plan,
      plan_name: work.plan_name,
      status: work.status,
      started_at: work.started_at,
      session_ids: work.session_ids,
      ...(work.waiting === undefined ? {} : { waiting: work.waiting }),
      works: { [work.work_id]: work },
    }),
    "utf-8",
  )
}

function createWork(input: {
  readonly status: BoulderWorkStatus
  readonly source?: BoulderWaitingMetadata["source"]
}): BoulderWorkState {
  return {
    work_id: "waiting-work",
    active_plan: planPath,
    plan_name: "waiting",
    status: input.status,
    started_at: "2026-07-31T10:00:00.000Z",
    session_ids: [],
    ...(input.source === undefined
      ? {}
      : {
          waiting: {
            reason: "Need a human decision",
            since: "2026-07-31T10:01:00.000Z",
            source: input.source,
          },
        }),
  }
}

function incidentPlan(): string {
  const completed = Array.from({ length: 6 }, (_, index) => `- [x] ${index + 1}. completed`)
  const blocked = Array.from({ length: 13 }, (_, index) => `- [~] ${index + 7}. blocked`)
  const remaining = Array.from({ length: 3 }, (_, index) => `- [ ] ${index + 20}. remaining`)
  return ["## TODOs", ...completed, ...blocked, ...remaining].join("\n")
}

afterEach(() => {
  for (const directory of cleanupRoots.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

describe("checkPlanWaiting", () => {
  test("#given an incident-shape plan and question-tool waiting #when checking #then it stays waiting without stale reporting", () => {
    // given
    const directory = createTempDirectory()
    const work = createWork({ status: "waiting_on_human", source: "question-tool" })
    writePlan(directory, incidentPlan())

    // when
    const result = checkPlanWaiting(directory, work)

    // then
    expect(result).toEqual({ waiting: true, stale: null })
  })

  test("#given an incident-shape plan and plan-blocked waiting #when checking #then it reports runnable stale without writing", () => {
    // given
    const directory = createTempDirectory()
    const work = createWork({ status: "waiting_on_human", source: "plan-blocked" })
    writePlan(directory, incidentPlan())
    writeRawState(directory, work)
    const before = readFileSync(join(directory, boulderPath), "utf-8")

    // when
    const result = checkPlanWaiting(directory, work)

    // then
    expect(result).toEqual({ waiting: true, stale: "runnable" })
    expect(readFileSync(join(directory, boulderPath), "utf-8")).toBe(before)
  })

  test("#given question-tool waiting and no blocked checkbox #when checking #then persisted waiting stays authoritative", () => {
    // given
    const directory = createTempDirectory()
    const work = createWork({ status: "waiting_on_human", source: "question-tool" })
    writePlan(directory, "## TODOs\n- [ ] 1. runnable")

    // when
    const result = checkPlanWaiting(directory, work)

    // then
    expect(result).toEqual({ waiting: true, stale: null })
  })

  test("#given an active work and a fully blocked plan #when checking #then the plan heuristic waits", () => {
    // given
    const directory = createTempDirectory()
    const work = createWork({ status: "active" })
    writePlan(directory, "## TODOs\n- [~] 1. blocked\n- [~] 2. blocked")

    // when
    const result = checkPlanWaiting(directory, work)

    // then
    expect(result).toEqual({ waiting: true, stale: null })
  })

  test("#given plan-blocked waiting and a fully blocked plan #when checking #then it does not report stale", () => {
    // given
    const directory = createTempDirectory()
    const work = createWork({ status: "waiting_on_human", source: "plan-blocked" })
    writePlan(directory, "## TODOs\n- [~] 1. blocked\n- [~] 2. blocked")

    // when
    const result = checkPlanWaiting(directory, work)

    // then
    expect(result).toEqual({ waiting: true, stale: null })
  })

  test("#given missing and corrupt plans with waiting state #when checking #then both fail closed without throwing", () => {
    // given
    const directory = createTempDirectory()
    const work = createWork({ status: "waiting_on_human", source: "question-tool" })
    const unreadableResults = [
      () => checkPlanWaiting(directory, work),
      () => {
        writePlan(directory, "this is not a checklist")
        return checkPlanWaiting(directory, work)
      },
    ]

    // when
    const results = unreadableResults.map((check) => check())

    // then
    expect(results).toEqual([
      { waiting: true, stale: null },
      { waiting: true, stale: null },
    ])
  })

  test("#given a completed plan and waiting state #when checking #then it reports complete stale without writing", () => {
    // given
    const directory = createTempDirectory()
    const work = createWork({ status: "waiting_on_human", source: "plan-blocked" })
    writePlan(directory, "## TODOs\n- [x] 1. completed\n- [x] 2. completed")
    writeRawState(directory, work)
    const before = readFileSync(join(directory, boulderPath), "utf-8")

    // when
    const result = checkPlanWaiting(directory, work)

    // then
    expect(result).toEqual({ waiting: true, stale: "complete" })
    expect(readFileSync(join(directory, boulderPath), "utf-8")).toBe(before)
  })
})
