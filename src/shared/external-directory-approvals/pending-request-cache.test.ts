/// <reference types="bun-types" />
/// <reference path="../../../bun-test.d.ts" />

import { beforeEach, describe, expect, test } from "bun:test"
import {
  clearAllPending,
  PENDING_CACHE_MAX_ENTRIES,
  PENDING_CACHE_TTL_MS,
  putPending,
  putPendingFromAsked,
  takePending,
} from "./index"

describe("external-directory pending-request cache", () => {
  beforeEach(() => {
    clearAllPending()
  })

  describe("#put-take one-shot", () => {
    test("put then take returns the dir exactly once", () => {
      //#given
      putPending("ses_a", "req1", "/tmp/omo-a")

      //#when
      const first = takePending("ses_a", "req1")
      const second = takePending("ses_a", "req1")

      //#then
      expect(first).toBe("/tmp/omo-a")
      expect(second).toBeUndefined()
    })

    test("take without a prior put returns undefined", () => {
      //#when
      const result = takePending("ses_a", "missing")

      //#then
      expect(result).toBeUndefined()
    })
  })

  describe("#isolation", () => {
    test("same requestID under different sessions does not bleed", () => {
      //#given
      putPending("ses_a", "req1", "/tmp/omo-a")
      putPending("ses_b", "req1", "/tmp/omo-b")

      //#when
      const fromA = takePending("ses_a", "req1")
      const fromB = takePending("ses_b", "req1")

      //#then
      expect(fromA).toBe("/tmp/omo-a")
      expect(fromB).toBe("/tmp/omo-b")
    })

    test("different requestIDs under the same session are independent", () => {
      //#given
      putPending("ses_a", "req1", "/tmp/omo-a")
      putPending("ses_a", "req2", "/tmp/omo-b")

      //#when
      const one = takePending("ses_a", "req1")

      //#then - taking req1 leaves req2 intact
      expect(one).toBe("/tmp/omo-a")
      expect(takePending("ses_a", "req2")).toBe("/tmp/omo-b")
    })

    test("composite key does not collide across split boundaries", () => {
      //#given - naive `sessionID:requestID` concatenation would collide here
      putPending("a", "b:c", "/tmp/omo-left")
      putPending("a:b", "c", "/tmp/omo-right")

      //#when
      const left = takePending("a", "b:c")
      const right = takePending("a:b", "c")

      //#then
      expect(left).toBe("/tmp/omo-left")
      expect(right).toBe("/tmp/omo-right")
    })
  })

  describe("#ttl", () => {
    test("entry within its TTL is returned", () => {
      //#given
      const t0 = 1_000
      putPending("ses_a", "req1", "/tmp/omo-a", t0)

      //#when
      const result = takePending("ses_a", "req1", t0 + PENDING_CACHE_TTL_MS - 1)

      //#then
      expect(result).toBe("/tmp/omo-a")
    })

    test("entry past its TTL is treated as a miss", () => {
      //#given
      const t0 = 1_000
      putPending("ses_a", "req1", "/tmp/omo-a", t0)

      //#when
      const result = takePending("ses_a", "req1", t0 + PENDING_CACHE_TTL_MS + 1)

      //#then
      expect(result).toBeUndefined()
    })

    test("an abandoned expired entry is swept opportunistically by a later take", () => {
      //#given - A asked early, B asked far later
      const t0 = 1_000
      putPending("ses_a", "reqA", "/tmp/omo-a", t0)
      putPending("ses_a", "reqB", "/tmp/omo-b", t0 + PENDING_CACHE_TTL_MS)

      //#when - take A after A expired but while B is still live
      const now = t0 + PENDING_CACHE_TTL_MS + 1
      const expiredA = takePending("ses_a", "reqA", now)

      //#then - A is gone, B survives
      expect(expiredA).toBeUndefined()
      expect(takePending("ses_a", "reqB", now)).toBe("/tmp/omo-b")
    })
  })

  describe("#size cap", () => {
    test("oldest entry is evicted once the cap is exceeded", () => {
      //#given - fill exactly one past the cap at a single instant
      const now = 1_000
      for (let index = 0; index <= PENDING_CACHE_MAX_ENTRIES; index++) {
        putPending("ses_a", `req${index}`, `/tmp/omo-${index}`, now)
      }

      //#when
      const oldest = takePending("ses_a", "req0", now)
      const newest = takePending(
        "ses_a",
        `req${PENDING_CACHE_MAX_ENTRIES}`,
        now,
      )

      //#then - the first inserted entry was evicted, the newest remains
      expect(oldest).toBeUndefined()
      expect(newest).toBe(`/tmp/omo-${PENDING_CACHE_MAX_ENTRIES}`)
    })
  })

  describe("#fail-closed put", () => {
    test("a relative parentDir is rejected and stores nothing", () => {
      //#when
      putPending("ses_a", "req1", "relative/dir")

      //#then
      expect(takePending("ses_a", "req1")).toBeUndefined()
    })

    test("an empty parentDir is rejected and stores nothing", () => {
      //#when
      putPending("ses_a", "req1", "")

      //#then
      expect(takePending("ses_a", "req1")).toBeUndefined()
    })

    test("an invalid parentDir is rejected and stores nothing", () => {
      //#given
      const invalidParentDir = "/tmp/omo-a\u0000ambiguous"

      //#when
      putPending("ses_a", "req1", invalidParentDir)

      //#then
      expect(takePending("ses_a", "req1")).toBeUndefined()
    })

    test("an empty sessionID or requestID is rejected", () => {
      //#when
      putPending("", "req1", "/tmp/omo-a")
      putPending("ses_a", "", "/tmp/omo-a")

      //#then
      expect(takePending("", "req1")).toBeUndefined()
      expect(takePending("ses_a", "")).toBeUndefined()
    })
  })

  describe("#extraction from permission.asked", () => {
    test("external_directory ask with an absolute parentDir is cached", () => {
      //#given
      const stored = putPendingFromAsked({
        sessionID: "ses_a",
        id: "req1",
        permission: "external_directory",
        metadata: { parentDir: "/tmp/omo-a", filepath: "/tmp/omo-a/file.txt" },
      })

      //#then - the dir round-trips by requestID (asked.id === replied.requestID)
      expect(stored).toBe("/tmp/omo-a")
      expect(takePending("ses_a", "req1")).toBe("/tmp/omo-a")
    })

    test("a non-external permission ask is not cached", () => {
      //#given
      const stored = putPendingFromAsked({
        sessionID: "ses_a",
        id: "req1",
        permission: "bash",
        metadata: { parentDir: "/tmp/omo-a" },
      })

      //#then
      expect(stored).toBeUndefined()
      expect(takePending("ses_a", "req1")).toBeUndefined()
    })

    test("an external ask missing parentDir is not cached", () => {
      //#given
      const stored = putPendingFromAsked({
        sessionID: "ses_a",
        id: "req1",
        permission: "external_directory",
        metadata: { filepath: "/tmp/omo-a/file.txt" },
      })

      //#then
      expect(stored).toBeUndefined()
      expect(takePending("ses_a", "req1")).toBeUndefined()
    })

    test("an external ask with a non-absolute parentDir is not cached", () => {
      //#given
      const stored = putPendingFromAsked({
        sessionID: "ses_a",
        id: "req1",
        permission: "external_directory",
        metadata: { parentDir: "relative/dir" },
      })

      //#then
      expect(stored).toBeUndefined()
      expect(takePending("ses_a", "req1")).toBeUndefined()
    })

    test("an external ask with a non-string parentDir is not cached", () => {
      //#given
      const stored = putPendingFromAsked({
        sessionID: "ses_a",
        id: "req1",
        permission: "external_directory",
        metadata: { parentDir: 42 },
      })

      //#then
      expect(stored).toBeUndefined()
      expect(takePending("ses_a", "req1")).toBeUndefined()
    })


    test("an external ask with an invalid parentDir is not cached", () => {
      //#given
      const invalidParentDir = "/tmp/omo-a\u0000ambiguous"
      const stored = putPendingFromAsked({
        sessionID: "ses_a",
        id: "req1",
        permission: "external_directory",
        metadata: { parentDir: invalidParentDir },
      })

      //#then
      expect(stored).toBeUndefined()
      expect(takePending("ses_a", "req1")).toBeUndefined()
    })
  })
})
