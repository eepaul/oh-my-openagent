import { sep } from "path"

export type SessionPermissionRule = {
  permission: string
  action: "allow" | "deny"
  pattern: string
}

export const QUESTION_DENIED_SESSION_PERMISSION: SessionPermissionRule[] = [
  { permission: "question", action: "deny", pattern: "*" },
]

function toExternalDirectoryPattern(directoryPath: string): string {
  return directoryPath.endsWith(sep) ? `${directoryPath}**` : `${directoryPath}${sep}**`
}

export function withExternalDirectoryApprovalRules(
  baseRules: readonly SessionPermissionRule[] | undefined,
  approvedDirectories: readonly string[],
): SessionPermissionRule[] | undefined {
  if ((!baseRules || baseRules.length === 0) && approvedDirectories.length === 0) {
    return undefined
  }

  const nextRules = [...(baseRules ?? [])]
  const existingExternalDirectoryPatterns = new Set(
    nextRules
      .filter((rule) => rule.permission === "external_directory" && rule.action === "allow")
      .map((rule) => rule.pattern),
  )

  for (const approvedDirectory of approvedDirectories) {
    const pattern = toExternalDirectoryPattern(approvedDirectory)
    if (existingExternalDirectoryPatterns.has(pattern)) {
      continue
    }
    nextRules.push({ permission: "external_directory", action: "allow", pattern })
    existingExternalDirectoryPatterns.add(pattern)
  }

  return nextRules
}
