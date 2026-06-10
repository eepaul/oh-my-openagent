/// <reference types="bun-types" />
/// <reference path="../../../bun-test.d.ts" />

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  clearAllApprovals,
  clearSessionApprovals,
  hasApproval,
  inheritApprovals,
  recordApproval,
} from "./index"

describe("external-directory-approvals memo", () => {
  beforeEach(() => {
    clearAllApprovals()
  })

  test("parent approval is visible to child after inherit", () => {
    //#given
    const parent = "ses_parent"
    const child = "ses_child"
    recordApproval(parent, "/tmp/project/external")

    //#when
    inheritApprovals(parent, child)

    //#then
    expect(hasApproval(child, "/tmp/project/external")).toBe(true)
  })

  test("inherit without prior parent approval grants nothing", () => {
    //#given
    const parent = "ses_parent_empty"
    const child = "ses_child_empty"

    //#when
    inheritApprovals(parent, child)

    //#then
    expect(hasApproval(child, "/tmp/project/external")).toBe(false)
  })

  test("distinct sibling directory is not approved", () => {
    //#given
    const session = "ses_distinct"
    recordApproval(session, "/tmp/project/allowed")

    //#when
    const siblingApproved = hasApproval(session, "/tmp/project/other")

    //#then
    expect(hasApproval(session, "/tmp/project/allowed")).toBe(true)
    expect(siblingApproved).toBe(false)
  })

  test("cleanup on delete clears approvals", () => {
    //#given
    const session = "ses_cleanup"
    recordApproval(session, "/tmp/project/external")
    expect(hasApproval(session, "/tmp/project/external")).toBe(true)

    //#when
    clearSessionApprovals(session)

    //#then
    expect(hasApproval(session, "/tmp/project/external")).toBe(false)
  })

  test("cleanup of one session does not affect siblings", () => {
    //#given
    recordApproval("ses_a", "/tmp/a")
    recordApproval("ses_b", "/tmp/b")

    //#when
    clearSessionApprovals("ses_a")

    //#then
    expect(hasApproval("ses_a", "/tmp/a")).toBe(false)
    expect(hasApproval("ses_b", "/tmp/b")).toBe(true)
  })

  test("approval is keyed by exact canonical directory, not a boolean flag", () => {
    //#given
    const session = "ses_canonical"
    recordApproval(session, "/tmp/project/external")

    //#when - a different directory under the same approved session
    const otherDir = hasApproval(session, "/tmp/project/another")

    //#then - approval is per-directory, so a second dir is not implicitly approved
    expect(hasApproval(session, "/tmp/project/external")).toBe(true)
    expect(otherDir).toBe(false)
  })

  test("canonical path normalization collapses non-canonical segments consistently", () => {
    //#given
    const session = "ses_normalize"
    recordApproval(session, "/tmp/project/external/")

    //#when - same directory expressed with redundant `.`/`..` segments
    const viaDotDot = hasApproval(session, "/tmp/project/external/nested/..")

    //#then
    expect(viaDotDot).toBe(true)
  })

  describe("realpath canonicalization (symlink)", () => {
    let tempRoot: string

    beforeEach(() => {
      tempRoot = mkdtempSync(join(tmpdir(), "extdir-approval-"))
    })

    afterEach(() => {
      rmSync(tempRoot, { recursive: true, force: true })
    })

    test("symlinked directory canonicalizes to the same real path", () => {
      //#given
      const realDir = join(tempRoot, "realdir")
      const linkDir = join(tempRoot, "linkdir")
      const siblingDir = join(tempRoot, "sibling")
      mkdirSync(realDir)
      mkdirSync(siblingDir)
      symlinkSync(realDir, linkDir)
      const session = "ses_symlink"
      recordApproval(session, linkDir)

      //#when
      const approvedViaReal = hasApproval(session, realDir)
      const siblingApproved = hasApproval(session, siblingDir)

      //#then
      expect(approvedViaReal).toBe(true)
      expect(siblingApproved).toBe(false)
    })
  })
})
