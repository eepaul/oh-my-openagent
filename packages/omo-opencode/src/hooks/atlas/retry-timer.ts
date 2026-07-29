import type { SessionState } from "./types"

export function clearPendingRetryTimer(sessionState: SessionState): void {
  if (sessionState.pendingRetryTimer) {
    clearTimeout(sessionState.pendingRetryTimer)
    sessionState.pendingRetryTimer = undefined
  }
}
