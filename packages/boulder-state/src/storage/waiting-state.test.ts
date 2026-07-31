/// <reference path="../../../../bun-test.d.ts" />

import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  addBoulderWork,
  completeBoulder,
  createBoulderState,
  enterWaitingOnHuman,
  getWorkById,
  readBoulderState,
  resumeFromHuman,
  writeBoulderState,
} from "../index"
import * as writeState from "./write-state"

const cleanupRoots: string[] = []

function createTempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "boulder-waiting-transition-"))
  cleanupRoots.push(directory)
  return directory
}

function createPersistedWork(directory: string): string {
  const state = createBoulderState(".omo/plans/waiting.md", "initial")
  const workId = state.active_work_id
  if (!workId) {
    throw new Error("createBoulderState must produce an active work")
  }
  if (!writeBoulderState(directory, state)) {
    throw new Error("test fixture must persist boulder state")
  }
  return workId
}

function serializedWork(directory: string, workId: string): string {
  const work = readBoulderState(directory)?.works?.[workId]
  if (!work) {
    throw new Error("test fixture must contain requested work")
  }
  return JSON.stringify(work)
}

afterEach(() => {
  for (const directory of cleanupRoots.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

describe("waiting state transitions", () => {
  test("#given an active work #when entering waiting on a question #then it persists the stable call ID", () => {
    // given
    const directory = createTempDirectory()
    const workId = createPersistedWork(directory)

    // when
    const result = enterWaitingOnHuman(directory, workId, {
      reason: "Need a human to choose the migration target",
      source: "question-tool",
      question_call_id: "call_stable_123",
    })

    // then
    expect(result).toBe(true)
    expect(getWorkById(directory, workId)).toMatchObject({
      status: "waiting_on_human",
      waiting: {
        reason: "Need a human to choose the migration target",
        source: "question-tool",
        question_call_id: "call_stable_123",
      },
    })
  })

  test("#given a waiting work #when entering again #then it preserves since and updates the call ID", () => {
    // given
    const directory = createTempDirectory()
    const workId = createPersistedWork(directory)
    enterWaitingOnHuman(directory, workId, {
      reason: "Need an initial answer",
      source: "question-tool",
      question_call_id: "call_first",
    })
    const originalSince = getWorkById(directory, workId)?.waiting?.since
    expect(typeof originalSince).toBe("string")

    // when
    const updatedQuestion = enterWaitingOnHuman(directory, workId, {
      reason: "Need a revised answer",
      source: "question-tool",
      question_call_id: "call_second",
    })
    const updatedSource = enterWaitingOnHuman(directory, workId, {
      reason: "Need approval instead",
      source: "plan-blocked",
    })

    // then
    expect(updatedQuestion).toBe(true)
    expect(updatedSource).toBe(true)
    expect(getWorkById(directory, workId)).toMatchObject({
      waiting: {
        reason: "Need approval instead",
        since: originalSince,
        source: "plan-blocked",
      },
    })
    expect(getWorkById(directory, workId)?.waiting?.question_call_id).toBeUndefined()
  })

  test("#given a waiting work #when resuming from a human #then it becomes active without waiting metadata", () => {
    // given
    const directory = createTempDirectory()
    const workId = createPersistedWork(directory)
    enterWaitingOnHuman(directory, workId, { reason: "Need approval", source: "plan-blocked" })

    // when
    const result = resumeFromHuman(directory, workId)

    // then
    expect(result).toBe(true)
    expect(getWorkById(directory, workId)).toMatchObject({ status: "active" })
    expect(getWorkById(directory, workId)?.waiting).toBeUndefined()
  })

  test("#given an active work #when resuming from a human #then it is a no-op", () => {
    // given
    const directory = createTempDirectory()
    const workId = createPersistedWork(directory)
    const before = readFileSync(join(directory, ".omo", "boulder.json"), "utf-8")

    // when
    const result = resumeFromHuman(directory, workId)

    // then
    expect(result).toBe(true)
    expect(readFileSync(join(directory, ".omo", "boulder.json"), "utf-8")).toBe(before)
  })

  test("#given a waiting work #when completing it #then completion clears waiting metadata", () => {
    // given
    const directory = createTempDirectory()
    const workId = createPersistedWork(directory)
    enterWaitingOnHuman(directory, workId, { reason: "Need approval", source: "plan-blocked" })

    // when
    const result = completeBoulder(directory, workId, "2026-07-31T12:00:00.000Z")

    // then
    expect(result?.works?.[workId]).toMatchObject({ status: "completed" })
    expect(getWorkById(directory, workId)?.waiting).toBeUndefined()
  })

  test("#given a persisted state #when entering an unknown work #then it returns false without changing the file", () => {
    // given
    const directory = createTempDirectory()
    createPersistedWork(directory)
    const before = readFileSync(join(directory, ".omo", "boulder.json"), "utf-8")

    // when
    const result = enterWaitingOnHuman(directory, "missing-work", { reason: "No target", source: "plan-blocked" })

    // then
    expect(result).toBe(false)
    expect(readFileSync(join(directory, ".omo", "boulder.json"), "utf-8")).toBe(before)
  })

  test("#given a waiting work and a failed write #when resuming #then it returns false and remains waiting", () => {
    // given
    const directory = createTempDirectory()
    const workId = createPersistedWork(directory)
    enterWaitingOnHuman(directory, workId, { reason: "Need approval", source: "plan-blocked" })
    const writeSpy = spyOn(writeState, "writeBoulderState").mockReturnValue(false)

    try {
      // when
      const result = resumeFromHuman(directory, workId)

      // then
      expect(result).toBe(false)
      expect(getWorkById(directory, workId)).toMatchObject({ status: "waiting_on_human" })
      expect(getWorkById(directory, workId)?.waiting).toBeDefined()
    } finally {
      writeSpy.mockRestore()
    }
  })

  test("#given two works #when transitioning the active work #then the other work and root mirror stay isolated", () => {
    // given
    const directory = createTempDirectory()
    const firstWorkId = createPersistedWork(directory)
    const addedState = addBoulderWork(directory, { planPath: ".omo/plans/target.md", sessionId: "target" })
    const targetWorkId = addedState?.active_work_id
    if (!targetWorkId || targetWorkId === firstWorkId) {
      throw new Error("addBoulderWork must select a distinct active work")
    }
    const nonTargetSerialized = serializedWork(directory, firstWorkId)

    // when
    enterWaitingOnHuman(directory, targetWorkId, { reason: "Need approval", source: "plan-blocked" })
    resumeFromHuman(directory, targetWorkId)
    completeBoulder(directory, targetWorkId, "2026-07-31T12:00:00.000Z")
    const persisted = readBoulderState(directory)

    // then
    expect(serializedWork(directory, firstWorkId)).toBe(nonTargetSerialized)
    expect(persisted).toMatchObject({
      active_work_id: targetWorkId,
      plan_name: "target",
      status: "completed",
    })
    expect(persisted?.waiting).toBeUndefined()
    expect(persisted?.works?.[targetWorkId]?.waiting).toBeUndefined()
  })
})
