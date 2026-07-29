import { archiveBoulderState } from "../features/boulder-state"
import { log } from "../shared"

export type BoulderArchiveResult =
  | { readonly boulder: "archived"; readonly archivedPath: string }
  | { readonly boulder: "missing" }
  | { readonly boulder: "failed"; readonly error: string }

type StopContinuationHooks = {
  readonly stopContinuationGuard?: {
    readonly stop?: (sessionID: string) => void
  } | null
  readonly todoContinuationEnforcer?: {
    readonly cancelAllCountdowns: () => void
  } | null
  readonly goal?: {
    readonly clearGoal: (sessionID: string) => boolean
  } | null
}

export function stopContinuation(args: {
  readonly directory: string
  readonly hooks: StopContinuationHooks
  readonly sessionID: string
}): BoulderArchiveResult {
  const { directory, hooks, sessionID } = args
  hooks.stopContinuationGuard?.stop?.(sessionID)
  hooks.todoContinuationEnforcer?.cancelAllCountdowns()
  hooks.goal?.clearGoal(sessionID)

  let boulder: BoulderArchiveResult
  try {
    const archivedPath = archiveBoulderState(directory)
    boulder = archivedPath === null
      ? { boulder: "missing" }
      : { boulder: "archived", archivedPath }
  } catch (error) {
    boulder = {
      boulder: "failed",
      error: error instanceof Error ? error.message : String(error),
    }
  }

  log("[stop-continuation] All continuation mechanisms stopped", { sessionID })
  return boulder
}

export function formatBoulderArchiveNotice(result: BoulderArchiveResult): string {
  switch (result.boulder) {
    case "archived":
      return [
        `Boulder state archived to ${result.archivedPath}.`,
        "把该文件 rename 回 `.omo/boulder.json`，然后在要继续工作的 session 中运行 `/start-work <plan-name>` 重新绑定并清除停机标志；若任务仍全部 `[~]`，先做出所需决定并把相应 `[~]` 改回 `[ ]`。",
      ].join(" ")
    case "missing":
      return "No boulder work state existed; nothing was archived."
    case "failed":
      return `Boulder state archive FAILED (${result.error}); \`.omo/boulder.json\` was NOT removed.`
    default: {
      const unreachable: never = result
      return unreachable
    }
  }
}
