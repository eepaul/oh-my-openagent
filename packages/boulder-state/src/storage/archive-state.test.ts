/// <reference path="../../../../bun-test.d.ts" />

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import * as fs from "node:fs"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { readBoulderState } from "./read-state"
import { archiveBoulderState } from "./archive-state"

function createTempDirectory(): string {
  return mkdtempSync(join(tmpdir(), "boulder-archive-state-"))
}

function writeBoulderFile(directory: string, contents: string): string {
  const boulderDirectory = join(directory, ".omo")
  const filePath = join(boulderDirectory, "boulder.json")
  mkdirSync(boulderDirectory, { recursive: true })
  writeFileSync(filePath, contents, "utf-8")
  return filePath
}

afterEach(() => {
  mock.restore()
})

describe("archiveBoulderState", () => {
  test("#given a boulder file #when archiving state #then the byte-identical file is moved", () => {
    // given
    const directory = createTempDirectory()
    const sourcePath = writeBoulderFile(directory, '{"active_plan":".omo/plans/example.md"}\n')
    const originalBytes = readFileSync(sourcePath)
    const expectedArchivePath = join(directory, ".omo", "boulder.json.stopped-20260729T031500Z")
    const now = () => new Date("2026-07-29T03:15:00.000Z")

    // when
    const archivePath = archiveBoulderState(directory, now)

    // then
    expect(readBoulderState(directory)).toBeNull()
    expect(existsSync(sourcePath)).toBeFalse()
    expect(archivePath).toBe(expectedArchivePath)
    expect(readFileSync(expectedArchivePath)).toEqual(originalBytes)
  })

  test("#given an existing timestamp archive #when archiving again #then a numbered path preserves the first archive", () => {
    // given
    const directory = createTempDirectory()
    const now = () => new Date("2026-07-29T03:15:00.000Z")
    const firstSourcePath = writeBoulderFile(directory, '{"first":true}\n')
    const firstBytes = readFileSync(firstSourcePath)
    const firstArchivePath = join(directory, ".omo", "boulder.json.stopped-20260729T031500Z")
    archiveBoulderState(directory, now)
    writeBoulderFile(directory, '{"second":true}\n')

    // when
    const secondArchivePath = archiveBoulderState(directory, now)

    // then
    expect(secondArchivePath).toBe(`${firstArchivePath}-2`)
    expect(readFileSync(firstArchivePath)).toEqual(firstBytes)
  })

  test("#given no boulder file #when archiving state #then null is returned without creating files", () => {
    // given
    const directory = createTempDirectory()

    // when
    const archivePath = archiveBoulderState(directory)

    // then
    expect(archivePath).toBeNull()
    expect(existsSync(join(directory, ".omo"))).toBeFalse()
  })

  test("#given rename failure #when archiving state #then the original error propagates and source remains", () => {
    // given
    const directory = createTempDirectory()
    const sourcePath = writeBoulderFile(directory, '{"active_plan":".omo/plans/example.md"}\n')
    const originalBytes = readFileSync(sourcePath)
    const renameFailure = new Error("rename denied")
    spyOn(fs, "renameSync").mockImplementation(() => {
      throw renameFailure
    })

    // when
    const originalErrorPropagates = (() => {
      try {
        archiveBoulderState(directory)
        return false
      } catch (error) {
        if (error === renameFailure) return true
        throw error
      }
    })()

    // then
    expect(originalErrorPropagates).toBeTrue()
    expect(existsSync(sourcePath)).toBeTrue()
    expect(readFileSync(sourcePath)).toEqual(originalBytes)
  })
})
