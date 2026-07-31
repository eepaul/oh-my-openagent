import { describe, expect, test } from "bun:test"

import {
  COMPACTION_GRACE_MS,
  createCompactionGraceTracker,
} from "./compaction-grace-tracker"

type ManualTask = {
  readonly run: () => Promise<void>
  cancelled: boolean
}

function createManualScheduler(): {
  readonly tasks: ManualTask[]
  readonly schedule: (callback: () => Promise<void>, _delayMs: number) => { readonly cancel: () => void }
} {
  const tasks: ManualTask[] = []
  return {
    tasks,
    schedule: (callback) => {
      const task: ManualTask = { run: callback, cancelled: false }
      tasks.push(task)
      return { cancel: () => { task.cancelled = true } }
    },
  }
}

describe("createCompactionGraceTracker", () => {
  test("#given a recorded compaction #when the grace window has not elapsed #then both observers see the same exclusion", () => {
    // given
    let now = 10_000
    const tracker = createCompactionGraceTracker({ now: () => now })
    tracker.recordCompaction("ses-1")

    // when
    const duringGrace = tracker.isCompactionGraceActive("ses-1")
    now += COMPACTION_GRACE_MS + 1
    const afterGrace = tracker.isCompactionGraceActive("ses-1")

    // then
    expect(duringGrace).toBeTrue()
    expect(afterGrace).toBeFalse()
  })

  test("#given chat.message and message.updated observe one message #when their delayed work is scheduled #then it fires once", async () => {
    // given
    const manual = createManualScheduler()
    const tracker = createCompactionGraceTracker({ now: () => 1, schedule: manual.schedule })
    let fired = 0

    // when
    tracker.scheduleMessageResume({ sessionID: "ses-1", messageID: "msg-1", onFire: async () => { fired += 1 } })
    tracker.scheduleMessageResume({ sessionID: "ses-1", messageID: "msg-1", onFire: async () => { fired += 1 } })
    const task = manual.tasks[0]
    if (task === undefined) throw new Error("expected scheduled message resume")
    await task.run()

    // then
    expect(manual.tasks).toHaveLength(1)
    expect(fired).toBe(1)
  })

  test("#given a user message arrives before a compaction event #when compaction is recorded inside the ordering window #then its delayed resume is dropped", async () => {
    // given
    let now = 1
    const manual = createManualScheduler()
    const tracker = createCompactionGraceTracker({ now: () => now, schedule: manual.schedule })
    let fired = 0
    tracker.scheduleMessageResume({ sessionID: "ses-1", messageID: "msg-1", onFire: async () => { fired += 1 } })
    const task = manual.tasks[0]
    if (task === undefined) throw new Error("expected scheduled message resume")

    // when
    now += 1
    tracker.recordCompaction("ses-1")
    await task.run()

    // then
    expect(fired).toBe(0)
  })

  test("#given a deleted session has a pending message resume #when its tracker state is cleared #then the pending resume is cancelled", () => {
    // given
    const manual = createManualScheduler()
    const tracker = createCompactionGraceTracker({ now: () => 1, schedule: manual.schedule })
    tracker.scheduleMessageResume({ sessionID: "ses-1", messageID: "msg-1", onFire: async () => {} })
    const task = manual.tasks[0]
    if (task === undefined) throw new Error("expected scheduled message resume")

    // when
    tracker.clearSession("ses-1")

    // then
    expect(task.cancelled).toBeTrue()
    expect(tracker.isCompactionGraceActive("ses-1")).toBeFalse()
  })
})
