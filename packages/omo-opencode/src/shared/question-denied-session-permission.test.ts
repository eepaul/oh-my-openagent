import { describe, expect, test } from "bun:test"

import {
  QUESTION_DENIED_SESSION_PERMISSION,
  withExternalDirectoryApprovalRules,
} from "./question-denied-session-permission"

describe("withExternalDirectoryApprovalRules", () => {
  test("appends approved external-directory rules without mutating the base rule array", () => {
    //#given
    const baseRules = [...QUESTION_DENIED_SESSION_PERMISSION]

    //#when
    const rules = withExternalDirectoryApprovalRules(baseRules, ["/approved/external"])

    //#then
    expect(baseRules).toEqual(QUESTION_DENIED_SESSION_PERMISSION)
    expect(rules).toEqual([
      { permission: "question", action: "deny", pattern: "*" },
      { permission: "external_directory", action: "allow", pattern: "/approved/external/**" },
    ])
  })

  test("keeps a question-only rule array when no approvals exist", () => {
    //#given
    const baseRules = QUESTION_DENIED_SESSION_PERMISSION

    //#when
    const rules = withExternalDirectoryApprovalRules(baseRules, [])

    //#then
    expect(rules).toEqual(QUESTION_DENIED_SESSION_PERMISSION)
    expect(rules).not.toBe(QUESTION_DENIED_SESSION_PERMISSION)
  })

  test("does not duplicate an existing matching external-directory allow rule", () => {
    //#given
    const baseRules = [
      { permission: "question", action: "deny" as const, pattern: "*" },
      { permission: "external_directory", action: "allow" as const, pattern: "/approved/external/**" },
    ]

    //#when
    const rules = withExternalDirectoryApprovalRules(baseRules, ["/approved/external"])

    //#then
    expect(rules).toEqual(baseRules)
  })

  test("returns undefined when there are neither base rules nor approvals", () => {
    //#given
    const baseRules = undefined

    //#when
    const rules = withExternalDirectoryApprovalRules(baseRules, [])

    //#then
    expect(rules).toBeUndefined()
  })
})
