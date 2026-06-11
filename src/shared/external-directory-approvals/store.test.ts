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
  listApprovedDirectories,
  isPathApproved,
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

  test("lists approved directories as a sorted immutable snapshot", () => {
    //#given
    const session = "ses_list"
    recordApproval(session, "/tmp/project/z")
    recordApproval(session, "/tmp/project/a")

    //#when
    const approvedDirectories = listApprovedDirectories(session)
    recordApproval(session, "/tmp/project/m")

    //#then
    expect(approvedDirectories).toEqual(["/tmp/project/a", "/tmp/project/z"])
    expect(listApprovedDirectories(session)).toEqual(["/tmp/project/a", "/tmp/project/m", "/tmp/project/z"])
  })

  test("lists no directories for sessions without approval", () => {
    //#given
    const session = "ses_empty_list"

    //#when
    const approvedDirectories = listApprovedDirectories(session)

    //#then
    expect(approvedDirectories).toEqual([])
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

describe("isPathApproved descendant containment", () => {
  beforeEach(() => {
    clearAllApprovals()
  })

  test("exact approved directory is approved", () => {
    //#given
    const session = "ses_exact"
    recordApproval(session, "/tmp/omo-a")

    //#when
    const approved = isPathApproved(session, "/tmp/omo-a")

    //#then
    expect(approved).toBe(true)
  })

  test("descendant file under approved directory is approved", () => {
    //#given
    const session = "ses_descendant"
    recordApproval(session, "/tmp/omo-a")

    //#when
    const approved = isPathApproved(session, "/tmp/omo-a/nested/file.txt")

    //#then
    expect(approved).toBe(true)
  })

  test("sibling-prefix directory is not approved", () => {
    //#given - `/tmp/omo-a` is approved but `/tmp/omo-abc` shares only a string prefix
    const session = "ses_sibling_prefix"
    recordApproval(session, "/tmp/omo-a")

    //#when
    const approved = isPathApproved(session, "/tmp/omo-abc/file.txt")

    //#then
    expect(approved).toBe(false)
  })

  test("path under a session with no approvals is not approved", () => {
    //#given
    const session = "ses_no_approvals"

    //#when
    const approved = isPathApproved(session, "/tmp/omo-a/file.txt")

    //#then
    expect(approved).toBe(false)
  })

  test("descendant containment is inherited by child sessions", () => {
    //#given
    const parent = "ses_parent_desc"
    const child = "ses_child_desc"
    recordApproval(parent, "/tmp/omo-a")
    inheritApprovals(parent, child)

    //#when
    const descendantApproved = isPathApproved(child, "/tmp/omo-a/deep/path/file.txt")
    const siblingApproved = isPathApproved(child, "/tmp/omo-abc/file.txt")

    //#then
    expect(descendantApproved).toBe(true)
    expect(siblingApproved).toBe(false)
  })
})

describe("isPathApproved realpath + fail-closed", () => {
  let tempRoot: string

  beforeEach(() => {
    clearAllApprovals()
    tempRoot = mkdtempSync(join(tmpdir(), "extdir-contain-"))
  })

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true })
  })

  test("descendant addressed through a symlinked approved directory is approved", () => {
    //#given
    const realDir = join(tempRoot, "realdir")
    const linkDir = join(tempRoot, "linkdir")
    mkdirSync(realDir)
    symlinkSync(realDir, linkDir)
    const session = "ses_symlink_descendant"
    recordApproval(session, linkDir)

    //#when - addressed via both the symlink path and the real path
    const viaLink = isPathApproved(session, join(linkDir, "nested", "file.txt"))
    const viaReal = isPathApproved(session, join(realDir, "nested", "file.txt"))

    //#then
    expect(viaLink).toBe(true)
    expect(viaReal).toBe(true)
  })

  test("sibling of a symlinked approved directory is not approved", () => {
    //#given
    const realDir = join(tempRoot, "realdir")
    const linkDir = join(tempRoot, "linkdir")
    const siblingDir = join(tempRoot, "sibling")
    mkdirSync(realDir)
    mkdirSync(siblingDir)
    symlinkSync(realDir, linkDir)
    const session = "ses_symlink_sibling"
    recordApproval(session, linkDir)

    //#when
    const siblingApproved = isPathApproved(session, join(siblingDir, "file.txt"))

    //#then
    expect(siblingApproved).toBe(false)
  })

  test("a symlink escaping the approved directory resolves out and is not approved", () => {
    //#given - `escape` lives inside the approved dir but points outside it
    const approvedDir = join(tempRoot, "approved")
    const outsideDir = join(tempRoot, "outside")
    mkdirSync(approvedDir)
    mkdirSync(outsideDir)
    const escapeLink = join(approvedDir, "escape")
    symlinkSync(outsideDir, escapeLink)
    const session = "ses_symlink_escape"
    recordApproval(session, approvedDir)

    //#when
    const escapeApproved = isPathApproved(session, join(escapeLink, "secret.txt"))

    //#then
    expect(escapeApproved).toBe(false)
  })

  test("a path that cannot be canonicalized fails closed to false", () => {
    //#given - approve the temp root so a naive prefix check would pass
    const session = "ses_failclosed_loop"
    recordApproval(session, tempRoot)
    const loopA = join(tempRoot, "loopA")
    const loopB = join(tempRoot, "loopB")
    symlinkSync(loopB, loopA)
    symlinkSync(loopA, loopB)

    //#when - resolving loopA throws ELOOP (ambiguous, not ENOENT)
    const approved = isPathApproved(session, join(loopA, "file.txt"))

    //#then
    expect(approved).toBe(false)
  })

  test("a path containing a null byte fails closed to false", () => {
    //#given - approve the temp root so a naive prefix check would pass
    const session = "ses_failclosed_nullbyte"
    recordApproval(session, tempRoot)

    //#when
    const approved = isPathApproved(session, join(tempRoot, "x\u0000y", "file.txt"))

    //#then
    expect(approved).toBe(false)
  })

  test("an empty candidate path fails closed to false", () => {
    //#given
    const session = "ses_failclosed_empty"
    recordApproval(session, tempRoot)

    //#when
    const approved = isPathApproved(session, "")

    //#then
    expect(approved).toBe(false)
  })
})

describe("child-cannot-override-parent copy semantics", () => {
  beforeEach(() => {
    clearAllApprovals()
  })

  test("a child recording its own approval does not leak into the parent", () => {
    //#given - child inherits a copy of the parent's standing grant
    const parent = "ses_parent_widen"
    const child = "ses_child_widen"
    recordApproval(parent, "/tmp/omo-a")
    inheritApprovals(parent, child)

    //#when - the child approves an additional directory of its own
    recordApproval(child, "/tmp/omo-b")

    //#then - the parent never gains the child-only approval
    expect(hasApproval(parent, "/tmp/omo-a")).toBe(true)
    expect(hasApproval(parent, "/tmp/omo-b")).toBe(false)
    expect(hasApproval(child, "/tmp/omo-b")).toBe(true)
  })

  test("a parent approval made after inherit does not retroactively reach the child", () => {
    //#given - inherit is a point-in-time copy, not a live alias of the parent set
    const parent = "ses_parent_pit"
    const child = "ses_child_pit"
    recordApproval(parent, "/tmp/omo-a")
    inheritApprovals(parent, child)

    //#when - the parent approves a second dir AFTER the child inherited
    recordApproval(parent, "/tmp/omo-b")

    //#then - the child only carries the snapshot it inherited
    expect(hasApproval(child, "/tmp/omo-a")).toBe(true)
    expect(hasApproval(child, "/tmp/omo-b")).toBe(false)
  })

  test("clearing a child session leaves the parent approval intact", () => {
    //#given
    const parent = "ses_parent_clear"
    const child = "ses_child_clear"
    recordApproval(parent, "/tmp/omo-a")
    inheritApprovals(parent, child)

    //#when - the child's approvals are wiped (e.g. the child session is deleted)
    clearSessionApprovals(child)

    //#then - the parent's standing grant survives the child cleanup
    expect(hasApproval(child, "/tmp/omo-a")).toBe(false)
    expect(hasApproval(parent, "/tmp/omo-a")).toBe(true)
  })

  test("clearing one inherited sibling does not clear another inherited sibling", () => {
    //#given - two children inherit the same parent grant as independent copies
    const parent = "ses_parent_sib"
    const childA = "ses_child_sib_a"
    const childB = "ses_child_sib_b"
    recordApproval(parent, "/tmp/omo-a")
    inheritApprovals(parent, childA)
    inheritApprovals(parent, childB)

    //#when
    clearSessionApprovals(childA)

    //#then
    expect(hasApproval(childA, "/tmp/omo-a")).toBe(false)
    expect(hasApproval(childB, "/tmp/omo-a")).toBe(true)
    expect(hasApproval(parent, "/tmp/omo-a")).toBe(true)
  })
})
