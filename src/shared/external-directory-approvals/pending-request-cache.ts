import { isAbsolute } from "path"

const EXTERNAL_DIRECTORY_PERMISSION = "external_directory"

export const PENDING_CACHE_TTL_MS = 5 * 60_000
export const PENDING_CACHE_MAX_ENTRIES = 1_000

interface PendingEntry {
  readonly sessionID: string
  readonly requestID: string
  readonly parentDir: string
  readonly expiresAt: number
}

export interface PendingPermissionAsk {
  readonly sessionID: string
  readonly id: string
  readonly permission: string
  readonly metadata: { readonly [key: string]: unknown }
}

const pendingByKey = new Map<string, PendingEntry>()

function makeKey(sessionID: string, requestID: string): string {
  return `${sessionID.length}:${sessionID}:${requestID}`
}

function sweepExpired(now: number): void {
  for (const [key, entry] of pendingByKey) {
    if (entry.expiresAt <= now) {
      pendingByKey.delete(key)
    }
  }
}

function enforceSizeCap(): void {
  while (pendingByKey.size >= PENDING_CACHE_MAX_ENTRIES) {
    const oldestKey = pendingByKey.keys().next().value
    if (oldestKey === undefined) {
      return
    }
    pendingByKey.delete(oldestKey)
  }
}

export function putPending(
  sessionID: string,
  requestID: string,
  parentDir: string,
  now: number = Date.now(),
): boolean {
  if (sessionID.length === 0 || requestID.length === 0) {
    return false
  }
  if (parentDir.length === 0 || parentDir.includes("\0") || !isAbsolute(parentDir)) {
    return false
  }

  sweepExpired(now)
  enforceSizeCap()

  const entry: PendingEntry = Object.freeze({
    sessionID,
    requestID,
    parentDir,
    expiresAt: now + PENDING_CACHE_TTL_MS,
  })
  pendingByKey.set(makeKey(sessionID, requestID), entry)
  return true
}

export function takePending(
  sessionID: string,
  requestID: string,
  now: number = Date.now(),
): string | undefined {
  if (sessionID.length === 0 || requestID.length === 0) {
    return undefined
  }

  const key = makeKey(sessionID, requestID)
  const entry = pendingByKey.get(key)
  if (entry !== undefined) {
    pendingByKey.delete(key)
  }
  sweepExpired(now)

  if (entry === undefined || entry.expiresAt <= now) {
    return undefined
  }
  return entry.parentDir
}

export function putPendingFromAsked(
  asked: PendingPermissionAsk,
  now: number = Date.now(),
): string | undefined {
  if (asked.permission !== EXTERNAL_DIRECTORY_PERMISSION) {
    return undefined
  }

  const parentDir = asked.metadata["parentDir"]
  if (typeof parentDir !== "string") {
    return undefined
  }

  return putPending(asked.sessionID, asked.id, parentDir, now) ? parentDir : undefined
}

export function clearAllPending(): void {
  pendingByKey.clear()
}
