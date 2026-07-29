/// <reference path="../../../bun-test.d.ts" />

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"

import {
  getPlanChecklist,
  getPlanProgress,
  isPlanLifecycleComplete,
  isPlanWaitingOnHuman,
} from "./index"

const cleanupRoots: string[] = []

function writePlan(markdown: string): string {
  const directory = mkdtempSync(join(tmpdir(), "boulder-waiting-on-human-"))
  cleanupRoots.push(directory)
  const planPath = join(directory, "plan.md")
  writeFileSync(planPath, markdown)
  return planPath
}

afterEach(() => {
  for (const root of cleanupRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe("waiting-on-human", () => {
  test("#given a plan containing only blocked TODOs #when evaluated #then it waits instead of completing", () => {
    // given
    const planPath = writePlan("## TODOs\n- [~] 1. a\n- [~] 2. b")

    // when
    const checklist = getPlanChecklist(planPath)

    // then
    expect(checklist).toEqual({ blocked: 2, completed: 0, remaining: 0, total: 0, nextTaskLabel: null })
    expect(isPlanWaitingOnHuman(planPath)).toBe(true)
    expect(isPlanLifecycleComplete(planPath)).toBe(false)
  })

  test("#given completed and blocked TODOs #when evaluated #then waiting vetoes parser completion", () => {
    // given
    const planPath = writePlan("## TODOs\n- [x] 1. a\n- [~] 2. b")

    // when
    const checklist = getPlanChecklist(planPath)

    // then
    expect(checklist).toEqual({ blocked: 1, completed: 1, remaining: 0, total: 1, nextTaskLabel: null })
    expect(getPlanProgress(planPath).isComplete).toBe(true)
    expect(isPlanWaitingOnHuman(planPath)).toBe(true)
    expect(isPlanLifecycleComplete(planPath)).toBe(false)
  })

  test("#given pending and blocked TODOs #when evaluated #then it continues instead of waiting", () => {
    // given
    const planPath = writePlan("## TODOs\n- [ ] 1. a\n- [~] 2. b")

    // when
    const checklist = getPlanChecklist(planPath)

    // then
    expect(checklist).toEqual({ blocked: 1, completed: 0, remaining: 1, total: 1, nextTaskLabel: "1. a" })
    expect(isPlanWaitingOnHuman(planPath)).toBe(false)
  })

  test("#given a fully completed plan #when evaluated #then its lifecycle completes normally", () => {
    // given
    const planPath = writePlan("## TODOs\n- [x] 1. a\n- [x] 2. b")

    // when
    const waiting = isPlanWaitingOnHuman(planPath)

    // then
    expect(waiting).toBe(false)
    expect(isPlanLifecycleComplete(planPath)).toBe(true)
  })

  test("#given a blocked checkbox inside a code fence #when parsed #then it is ignored", () => {
    // given
    const planPath = writePlan("## TODOs\n```md\n- [~] 1. x\n```")

    // when
    const checklist = getPlanChecklist(planPath)

    // then
    expect(checklist.blocked).toBe(0)
  })

  test("#given an unnumbered blocked structured row #when parsed #then it is ignored", () => {
    // given
    const planPath = writePlan("## TODOs\n- [~] foo")

    // when
    const checklist = getPlanChecklist(planPath)

    // then
    expect(checklist.blocked).toBe(0)
  })

  test("#given a nonexistent plan path #when evaluated #then it is neither waiting nor complete", () => {
    // given
    const directory = mkdtempSync(join(tmpdir(), "boulder-waiting-on-human-"))
    cleanupRoots.push(directory)
    const planPath = join(directory, "missing.md")

    // when
    const waiting = isPlanWaitingOnHuman(planPath)

    // then
    expect(waiting).toBe(false)
    expect(isPlanLifecycleComplete(planPath)).toBe(false)
  })
})
