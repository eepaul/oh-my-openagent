import { realpathSync } from "fs";
import { basename, dirname, join, resolve, sep } from "path";

const approvalsBySession = new Map<string, Set<string>>();

function canonicalizeDirectoryPath(directoryPath: string): string {
  const resolvedPath = resolve(directoryPath);

  try {
    return realpathSync(resolvedPath);
  } catch {
    return resolvedPath;
  }
}

export function recordApproval(sessionID: string, directoryPath: string): void {
  const existingApprovals = approvalsBySession.get(sessionID);
  const approvals = existingApprovals ?? new Set<string>();
  approvals.add(canonicalizeDirectoryPath(directoryPath));
  approvalsBySession.set(sessionID, approvals);
}

export function hasApproval(sessionID: string, directoryPath: string): boolean {
  const approvals = approvalsBySession.get(sessionID);
  return approvals?.has(canonicalizeDirectoryPath(directoryPath)) ?? false;
}

export function listApprovedDirectories(sessionID: string): readonly string[] {
  const approvals = approvalsBySession.get(sessionID);
  if (!approvals) {
    return [];
  }
  return [...approvals].sort();
}

export function inheritApprovals(parentSessionID: string, childSessionID: string): void {
  const parentApprovals = approvalsBySession.get(parentSessionID);
  if (!parentApprovals) {
    return;
  }

  approvalsBySession.set(childSessionID, new Set(parentApprovals));
}

export function clearSessionApprovals(sessionID: string): void {
  approvalsBySession.delete(sessionID);
}

export function clearAllApprovals(): void {
  approvalsBySession.clear();
}

function isPathNotFoundError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function canonicalizeLongestExistingPrefix(absolutePath: string): string | null {
  const reversedMissingSegments: string[] = [];
  let currentPath = absolutePath;

  while (true) {
    try {
      const realCurrentPath = realpathSync(currentPath);
      if (reversedMissingSegments.length === 0) {
        return realCurrentPath;
      }
      return join(realCurrentPath, ...[...reversedMissingSegments].reverse());
    } catch (error) {
      if (!isPathNotFoundError(error)) {
        return null;
      }
    }

    const parentPath = dirname(currentPath);
    if (parentPath === currentPath) {
      return null;
    }
    reversedMissingSegments.push(basename(currentPath));
    currentPath = parentPath;
  }
}

function canonicalizeCandidatePath(candidatePath: string): string | null {
  if (candidatePath.length === 0) {
    return null;
  }
  return canonicalizeLongestExistingPrefix(resolve(candidatePath));
}

function isWithinApprovedDirectory(canonicalCandidatePath: string, approvedDirectory: string): boolean {
  if (canonicalCandidatePath === approvedDirectory) {
    return true;
  }
  const approvedPrefix = approvedDirectory.endsWith(sep) ? approvedDirectory : `${approvedDirectory}${sep}`;
  return canonicalCandidatePath.startsWith(approvedPrefix);
}

export function isPathApproved(sessionID: string, candidatePath: string): boolean {
  const approvals = approvalsBySession.get(sessionID);
  if (!approvals || approvals.size === 0) {
    return false;
  }

  const canonicalCandidatePath = canonicalizeCandidatePath(candidatePath);
  if (canonicalCandidatePath === null) {
    return false;
  }

  for (const approvedDirectory of approvals) {
    if (isWithinApprovedDirectory(canonicalCandidatePath, approvedDirectory)) {
      return true;
    }
  }
  return false;
}
