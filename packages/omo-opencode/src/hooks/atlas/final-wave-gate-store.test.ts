import { describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  clearFinalWaveGate,
  type FinalWaveGate,
  isAwaitingFinalWaveApproval,
  readFinalWaveGate,
  writeFinalWaveGate,
} from "./final-wave-gate-store"

function createTempDirectory(): string {
  const directory = join(tmpdir(), `final-wave-gate-store-${randomUUID()}`)
  mkdirSync(directory, { recursive: true })
  return directory
}

function removeDirectory(directory: string): void {
  if (existsSync(directory)) {
    rmSync(directory, { recursive: true, force: true })
  }
}

function sidecarPath(directory: string): string {
  return join(directory, ".omo", "final-wave-gate.json")
}

function seedSidecar(directory: string, content: string): void {
  mkdirSync(join(directory, ".omo"), { recursive: true })
  writeFileSync(sidecarPath(directory), content, "utf-8")
}

function createGate(overrides: Partial<FinalWaveGate> = {}): FinalWaveGate {
  return {
    work_id: "atlas-final-wave-loop-fix",
    plan_name: "final-wave-plan",
    approved_count: 1,
    pending_count: 3,
    updated_at: "2026-06-13T00:00:00Z",
    ...overrides,
  }
}

describe("writeFinalWaveGate", () => {
  test("creates the .omo sidecar and persists a gate that read returns", () => {
    // given
    const directory = createTempDirectory()
    try {
      const gate = createGate()
      expect(existsSync(sidecarPath(directory))).toBe(false)

      // when
      writeFinalWaveGate(directory, gate)

      // then
      expect(existsSync(sidecarPath(directory))).toBe(true)
      expect(readFinalWaveGate(directory, gate.work_id)).toEqual(gate)
    } finally {
      removeDirectory(directory)
    }
  })

  test("creates the .omo directory when it does not yet exist", () => {
    // given
    const directory = createTempDirectory()
    try {
      expect(existsSync(join(directory, ".omo"))).toBe(false)

      // when
      writeFinalWaveGate(directory, createGate())

      // then
      expect(existsSync(join(directory, ".omo"))).toBe(true)
    } finally {
      removeDirectory(directory)
    }
  })

  test("stores entries as a map keyed by work_id", () => {
    // given
    const directory = createTempDirectory()
    try {
      const gate = createGate({ work_id: "work-keyed" })

      // when
      writeFinalWaveGate(directory, gate)

      // then
      const parsed = JSON.parse(readFileSync(sidecarPath(directory), "utf-8"))
      expect(parsed).toEqual({ "work-keyed": gate })
    } finally {
      removeDirectory(directory)
    }
  })

  test("preserves other works when writing a second gate to the shared map", () => {
    // given
    const directory = createTempDirectory()
    try {
      const first = createGate({ work_id: "work-a", plan_name: "plan-a" })
      const second = createGate({ work_id: "work-b", plan_name: "plan-b" })

      // when
      writeFinalWaveGate(directory, first)
      writeFinalWaveGate(directory, second)

      // then
      expect(readFinalWaveGate(directory, "work-a")).toEqual(first)
      expect(readFinalWaveGate(directory, "work-b")).toEqual(second)
    } finally {
      removeDirectory(directory)
    }
  })

  test("overwrites an existing gate for the same work_id", () => {
    // given
    const directory = createTempDirectory()
    try {
      const initial = createGate({ approved_count: 1 })
      const updated = createGate({ approved_count: 3, updated_at: "2026-06-14T00:00:00Z" })

      // when
      writeFinalWaveGate(directory, initial)
      writeFinalWaveGate(directory, updated)

      // then
      expect(readFinalWaveGate(directory, updated.work_id)).toEqual(updated)
    } finally {
      removeDirectory(directory)
    }
  })
})

describe("readFinalWaveGate", () => {
  test("returns null when the sidecar file is missing", () => {
    // given
    const directory = createTempDirectory()
    try {
      // when
      const result = readFinalWaveGate(directory, "any-work")

      // then
      expect(result).toBeNull()
    } finally {
      removeDirectory(directory)
    }
  })

  test("returns null for a work_id absent from the map", () => {
    // given
    const directory = createTempDirectory()
    try {
      writeFinalWaveGate(directory, createGate({ work_id: "present-work" }))

      // when
      const result = readFinalWaveGate(directory, "missing-work")

      // then
      expect(result).toBeNull()
    } finally {
      removeDirectory(directory)
    }
  })

  test("returns null for malformed JSON", () => {
    // given
    const directory = createTempDirectory()
    try {
      seedSidecar(directory, "{ this is not json")

      // when
      const result = readFinalWaveGate(directory, "any-work")

      // then
      expect(result).toBeNull()
    } finally {
      removeDirectory(directory)
    }
  })

  test("returns null when the top-level JSON is not an object", () => {
    // given
    const directory = createTempDirectory()
    try {
      seedSidecar(directory, "[]")

      // when
      const result = readFinalWaveGate(directory, "any-work")

      // then
      expect(result).toBeNull()
    } finally {
      removeDirectory(directory)
    }
  })

  test("returns null when the stored entry has an invalid shape", () => {
    // given
    const directory = createTempDirectory()
    try {
      const invalidEntry = {
        work_id: "broken-work",
        plan_name: 42,
        approved_count: "one",
        pending_count: 3,
        updated_at: "2026-06-13T00:00:00Z",
      }
      seedSidecar(directory, JSON.stringify({ "broken-work": invalidEntry }))

      // when
      const result = readFinalWaveGate(directory, "broken-work")

      // then
      expect(result).toBeNull()
    } finally {
      removeDirectory(directory)
    }
  })
})

describe("clearFinalWaveGate", () => {
  test("removes the sidecar file when the last work entry is cleared", () => {
    // given
    const directory = createTempDirectory()
    try {
      writeFinalWaveGate(directory, createGate({ work_id: "only-work" }))
      expect(existsSync(sidecarPath(directory))).toBe(true)

      // when
      clearFinalWaveGate(directory, "only-work")

      // then
      expect(existsSync(sidecarPath(directory))).toBe(false)
      expect(readFinalWaveGate(directory, "only-work")).toBeNull()
    } finally {
      removeDirectory(directory)
    }
  })

  test("removes only the keyed work and preserves other work entries", () => {
    // given
    const directory = createTempDirectory()
    try {
      const keep = createGate({ work_id: "work-keep", plan_name: "plan-keep" })
      const drop = createGate({ work_id: "work-drop", plan_name: "plan-drop" })
      writeFinalWaveGate(directory, keep)
      writeFinalWaveGate(directory, drop)

      // when
      clearFinalWaveGate(directory, "work-drop")

      // then
      expect(readFinalWaveGate(directory, "work-drop")).toBeNull()
      expect(readFinalWaveGate(directory, "work-keep")).toEqual(keep)
      expect(existsSync(sidecarPath(directory))).toBe(true)
    } finally {
      removeDirectory(directory)
    }
  })

  test("leaves other works intact when clearing a work_id that is absent", () => {
    // given
    const directory = createTempDirectory()
    try {
      const keep = createGate({ work_id: "present-work" })
      writeFinalWaveGate(directory, keep)

      // when
      clearFinalWaveGate(directory, "never-stored-work")

      // then
      expect(existsSync(sidecarPath(directory))).toBe(true)
      expect(readFinalWaveGate(directory, "present-work")).toEqual(keep)
    } finally {
      removeDirectory(directory)
    }
  })

  test("is a no-op when the sidecar file does not exist", () => {
    // given
    const directory = createTempDirectory()
    try {
      // when / then
      expect(() => clearFinalWaveGate(directory, "any-work")).not.toThrow()
    } finally {
      removeDirectory(directory)
    }
  })
})

describe("isAwaitingFinalWaveApproval", () => {
  test("returns false for null or undefined gates", () => {
    // given / when / then
    expect(isAwaitingFinalWaveApproval(null)).toBe(false)
    expect(isAwaitingFinalWaveApproval(undefined)).toBe(false)
  })

  test("returns false when pending_count is zero", () => {
    // given
    const gate = createGate({ approved_count: 0, pending_count: 0 })

    // when / then
    expect(isAwaitingFinalWaveApproval(gate)).toBe(false)
  })

  test("returns true when approvals are still outstanding", () => {
    // given
    const gate = createGate({ approved_count: 1, pending_count: 3 })

    // when / then
    expect(isAwaitingFinalWaveApproval(gate)).toBe(true)
  })

  test("returns false once approvals meet the pending count", () => {
    // given
    const gate = createGate({ approved_count: 3, pending_count: 3 })

    // when / then
    expect(isAwaitingFinalWaveApproval(gate)).toBe(false)
  })

  test("returns false when approvals exceed the pending count", () => {
    // given
    const gate = createGate({ approved_count: 4, pending_count: 3 })

    // when / then
    expect(isAwaitingFinalWaveApproval(gate)).toBe(false)
  })
})
