import { afterEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { getWorkForSession } from "@oh-my-opencode/boulder-state"

import { findContinuableBoulderWork } from "./boulder-eligibility"

const cleanupRoots: string[] = []

function createWorkspace(status: string): string {
  const root = mkdtempSync(join(tmpdir(), "senpi-boulder-eligibility-"))
  cleanupRoots.push(root)
  mkdirSync(join(root, ".omo", "plans"), { recursive: true })
  writeFileSync(join(root, ".omo", "plans", "plan.md"), "## TODOs\n- [ ] 1. Wait for the human\n")
  writeFileSync(
    join(root, ".omo", "boulder.json"),
    JSON.stringify({
      schema_version: 2,
      active_work_id: "work-1",
      works: {
        "work-1": {
          work_id: "work-1",
          active_plan: ".omo/plans/plan.md",
          plan_name: "plan",
          session_ids: ["senpi:qa-s1"],
          status,
          started_at: "2026-07-31T00:00:00Z",
        },
      },
    }),
  )
  return root
}

afterEach(() => {
  for (const root of cleanupRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe("findContinuableBoulderWork", () => {
  it("#given waiting_on_human boulder work #when eligibility is read #then recognizes it but does not continue", () => {
    const cwd = createWorkspace("waiting_on_human")

    const work = getWorkForSession(cwd, "senpi:qa-s1")
    const continuable = findContinuableBoulderWork(cwd, "qa-s1")

    expect(work?.status).toBe("waiting_on_human")
    expect(continuable).toBeNull()
  })

  it("#given unknown boulder status #when eligibility is read #then remains fail-closed", () => {
    const cwd = createWorkspace("bogus")

    const continuable = findContinuableBoulderWork(cwd, "qa-s1")

    expect(continuable).toBeNull()
  })
})
