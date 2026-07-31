import type { InternalInitiatorMessageLike } from "../../shared/internal-initiator-marker"
import type { CompactionGraceTracker } from "./compaction-grace-tracker"
import { captureHumanMessageResume, scheduleHumanMessageResume } from "./human-resume-controller"
import { isResumableHumanInput } from "./resumable-human-input"

type ScheduleDeferredHumanInput = {
  readonly directory: string
  readonly sessionID: string
  readonly messageID: string
  readonly message: InternalInitiatorMessageLike
}

export type DeferredHumanInputTracker = {
  readonly clearSession: (sessionID: string) => void
  readonly consumePending: (sessionID: string, messageID: string) => boolean
  readonly rememberPending: (sessionID: string, messageID: string) => void
  readonly scheduleIfResumable: (input: ScheduleDeferredHumanInput) => void
}

export function createDeferredHumanInputTracker(
  tracker: CompactionGraceTracker,
): DeferredHumanInputTracker {
  const pendingMessageIDs = new Map<string, Set<string>>()

  function rememberPending(sessionID: string, messageID: string): void {
    const pendingForSession = pendingMessageIDs.get(sessionID) ?? new Set<string>()
    pendingForSession.add(messageID)
    pendingMessageIDs.set(sessionID, pendingForSession)
  }

  function consumePending(sessionID: string, messageID: string): boolean {
    const pendingForSession = pendingMessageIDs.get(sessionID)
    if (pendingForSession === undefined || !pendingForSession.delete(messageID)) {
      return false
    }
    if (pendingForSession.size === 0) {
      pendingMessageIDs.delete(sessionID)
    }
    return true
  }

  return {
    rememberPending,
    consumePending,
    clearSession: (sessionID) => {
      pendingMessageIDs.delete(sessionID)
    },
    scheduleIfResumable: ({ directory, sessionID, messageID, message }) => {
      if (!isResumableHumanInput(message, {
        compactionGraceActive: tracker.isCompactionGraceActive(sessionID),
      })) {
        return
      }
      const snapshot = captureHumanMessageResume({ directory, sessionID, messageID })
      if (snapshot !== null) {
        scheduleHumanMessageResume({ tracker, snapshot })
      }
    },
  }
}
