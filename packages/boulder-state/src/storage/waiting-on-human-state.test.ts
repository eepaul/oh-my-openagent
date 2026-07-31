/// <reference path="../../../../bun-test.d.ts" />

import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  appendSessionId,
  createBoulderState,
  getActiveWorks,
  getWorkResumeOptions,
  readBoulderState,
  writeBoulderState,
} from "../index"

const cleanupRoots: string[] = []

function createTempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "boulder-waiting-state-"))
  cleanupRoots.push(directory)
  return directory
}

function writeRawState(directory: string, state: object): void {
  const boulderDirectory = join(directory, ".omo")
  mkdirSync(boulderDirectory, { recursive: true })
  writeFileSync(join(boulderDirectory, "boulder.json"), JSON.stringify(state), "utf-8")
}

afterEach(() => {
  for (const directory of cleanupRoots.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

describe("waiting_on_human state serialization", () => {
  test("#given a legacy waiting mirror #when rebuilding its work #then waiting metadata is retained and remains active", () => {
    // given
    const directory = createTempDirectory()
    const waiting = {
      reason: "Need a human to confirm the migration",
      since: "2026-07-31T09:00:00.000Z",
      source: "plan-blocked",
    }
    writeRawState(directory, {
      active_plan: ".omo/plans/legacy-waiting.md",
      plan_name: "legacy-waiting",
      status: "waiting_on_human",
      started_at: "2026-07-31T08:00:00.000Z",
      session_ids: [],
      waiting,
    })

    // when
    const activeWorks = getActiveWorks(directory)

    // then
    expect(activeWorks).toMatchObject([{ status: "waiting_on_human", waiting }])
  })

  test("#given a waiting work #when appending a session #then its mirror and resume option retain waiting metadata", () => {
    // given
    const directory = createTempDirectory()
    const waiting = {
      reason: "Need approval for the deployment window",
      since: "2026-07-31T09:00:00.000Z",
      source: "plan-blocked",
    }
    writeRawState(directory, {
      schema_version: 2,
      active_work_id: "waiting-work",
      active_plan: ".omo/plans/waiting.md",
      plan_name: "waiting",
      status: "waiting_on_human",
      started_at: "2026-07-31T08:00:00.000Z",
      session_ids: ["opencode:initial"],
      works: {
        "waiting-work": {
          work_id: "waiting-work",
          active_plan: ".omo/plans/waiting.md",
          plan_name: "waiting",
          status: "waiting_on_human",
          started_at: "2026-07-31T08:00:00.000Z",
          session_ids: ["opencode:initial"],
          waiting,
        },
      },
    })

    // when
    appendSessionId(directory, "follow-up", "appended")
    const state = readBoulderState(directory)
    const options = getWorkResumeOptions(directory)
    const activeWorks = getActiveWorks(directory)

    // then
    expect(state).toMatchObject({ waiting })
    expect(state?.works?.["waiting-work"]).toMatchObject({
      status: "waiting_on_human",
      waiting,
    })
    expect(options).toMatchObject([{ status: "waiting_on_human", waiting }])
    expect(activeWorks).toMatchObject([{ status: "waiting_on_human", waiting }])
  })

  test("#given root waiting metadata #when serializing then appending #then root-to-work synchronization preserves it", () => {
    // given
    const directory = createTempDirectory()
    const state = createBoulderState(".omo/plans/waiting.md", "initial")
    const workId = state.active_work_id
    if (!workId || !state.works?.[workId]) {
      throw new Error("createBoulderState must produce an active work")
    }
    const waiting = {
      reason: "Need the human to choose an API contract",
      since: "2026-07-31T09:00:00.000Z",
      source: "question-tool",
      question_call_id: "call_123",
    }
    Object.assign(state, { status: "waiting_on_human", waiting })
    writeBoulderState(directory, state)

    // when
    appendSessionId(directory, "follow-up", "appended")
    const persisted = readBoulderState(directory)

    // then
    expect(persisted?.works?.[workId]).toMatchObject({
      status: "waiting_on_human",
      waiting,
    })
  })

  test("#given an unknown work status #when reading resume options #then it still normalizes to active", () => {
    // given
    const directory = createTempDirectory()
    writeRawState(directory, {
      active_plan: ".omo/plans/bogus.md",
      plan_name: "bogus",
      status: "bogus",
      started_at: "2026-07-31T08:00:00.000Z",
      session_ids: [],
    })

    // when
    const options = getWorkResumeOptions(directory)

    // then
    expect(options).toMatchObject([{ status: "active" }])
  })
})
