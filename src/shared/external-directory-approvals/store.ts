import { realpathSync } from "fs";
import { resolve } from "path";

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
