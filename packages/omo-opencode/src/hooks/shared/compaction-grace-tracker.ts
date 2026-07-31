export const COMPACTION_GRACE_MS = 15_000
export const COMPACTION_ORDER_GRACE_MS = 2_000

type ScheduledTask = {
  readonly cancel: () => void
}

type DelayScheduler = (
  callback: () => Promise<void>,
  delayMs: number,
) => ScheduledTask

type ScheduleMessageResumeInput = {
  readonly sessionID: string
  readonly messageID: string
  readonly onFire: () => Promise<void>
}

export type CompactionGraceTracker = {
  readonly clearSession: (sessionID: string) => void
  readonly isCompactionGraceActive: (sessionID: string) => boolean
  readonly recordCompaction: (sessionID: string) => void
  readonly scheduleMessageResume: (input: ScheduleMessageResumeInput) => void
}

type CompactionGraceTrackerOptions = {
  readonly now?: () => number
  readonly schedule?: DelayScheduler
}

function messageKey(sessionID: string, messageID: string): string {
  return `${sessionID}\u0000${messageID}`
}

function createDefaultScheduler(): DelayScheduler {
  return (callback, delayMs) => {
    const timer = setTimeout(() => {
      void callback()
    }, delayMs)
    return { cancel: () => clearTimeout(timer) }
  }
}

export function createCompactionGraceTracker(
  options: CompactionGraceTrackerOptions = {},
): CompactionGraceTracker {
  const now = options.now ?? Date.now
  const schedule = options.schedule ?? createDefaultScheduler()
  const lastCompactedAt = new Map<string, number>()
  const scheduledResumes = new Map<string, ScheduledTask>()
  const resumeTombstones = new Set<string>()

  function isCompactionGraceActive(sessionID: string): boolean {
    const compactedAt = lastCompactedAt.get(sessionID)
    return compactedAt !== undefined && now() - compactedAt <= COMPACTION_GRACE_MS
  }

  return {
    recordCompaction: (sessionID) => {
      lastCompactedAt.set(sessionID, now())
    },
    isCompactionGraceActive,
    clearSession: (sessionID) => {
      lastCompactedAt.delete(sessionID)
      const prefix = `${sessionID}\u0000`
      for (const [key, task] of scheduledResumes) {
        if (!key.startsWith(prefix)) continue
        task.cancel()
        scheduledResumes.delete(key)
      }
      for (const key of resumeTombstones) {
        if (key.startsWith(prefix)) resumeTombstones.delete(key)
      }
    },
    scheduleMessageResume: ({ sessionID, messageID, onFire }) => {
      const key = messageKey(sessionID, messageID)
      if (resumeTombstones.has(key)) return
      resumeTombstones.add(key)
      const task = schedule(async () => {
        scheduledResumes.delete(key)
        if (isCompactionGraceActive(sessionID)) return
        await onFire()
      }, COMPACTION_ORDER_GRACE_MS)
      scheduledResumes.set(key, task)
    },
  }
}

export const compactionGraceTracker = createCompactionGraceTracker()
