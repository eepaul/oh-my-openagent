import pc from "picocolors"
import type { RunContext, Todo, ChildSession, SessionStatus } from "./types"
import { normalizeSDKResponse } from "../../shared"
import {
  getContinuationState,
  type ContinuationState,
  type WaitingBoulderContinuation,
} from "./continuation-state"

export type CompletionCheckResult =
  | "pending"
  | "completed"
  | { readonly waiting: WaitingBoulderContinuation }

export async function checkCompletionConditions(ctx: RunContext): Promise<CompletionCheckResult> {
  try {
    const continuationState = await getContinuationState(ctx.directory, ctx.sessionID, ctx.client)
    const waitingBoulder = getWaitingBoulderContinuation(continuationState)

    if (continuationState.hasActiveBackgroundTaskMarker) {
      logWaiting(ctx, continuationState.activeHookMarkerReason ?? "background tasks are active")
      return "pending"
    }

    if (continuationState.hasActiveHookMarker && !(waitingBoulder && continuationState.hasTodoHookMarker)) {
      const reason = continuationState.activeHookMarkerReason ?? "continuation hook is active"
      logWaiting(ctx, reason)
      return "pending"
    }

    if (!waitingBoulder && !continuationState.hasTodoHookMarker && !await areAllTodosComplete(ctx)) {
      return "pending"
    }

    if (!await areAllChildrenIdle(ctx)) {
      return "pending"
    }

    if (!areContinuationHooksIdle(ctx, continuationState)) {
      return "pending"
    }

    return waitingBoulder ? { waiting: waitingBoulder } : "completed"
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(pc.red(`[completion] API error: ${message}`))
    return "pending"
  }
}

function getWaitingBoulderContinuation(
  continuationState: ContinuationState,
): WaitingBoulderContinuation | null {
  return typeof continuationState.boulderContinuation === "string"
    ? null
    : continuationState.boulderContinuation.waiting
}

function areContinuationHooksIdle(
  ctx: RunContext,
  continuationState: ContinuationState
): boolean {
  if (continuationState.hasActiveBoulder) {
    logWaiting(ctx, "boulder continuation is active")
    return false
  }

  if (continuationState.hasActiveRalphLoop) {
    logWaiting(ctx, "ralph-loop continuation is active")
    return false
  }

  return true
}

async function areAllTodosComplete(ctx: RunContext): Promise<boolean> {
  const todosRes = await ctx.client.session.todo({
    path: { id: ctx.sessionID },
    query: { directory: ctx.directory },
  })
  const todos = normalizeSDKResponse(todosRes, [] as Todo[])

  const incompleteTodos = todos.filter(
    (t) => t.status !== "completed" && t.status !== "cancelled"
  )

  if (incompleteTodos.length > 0) {
    logWaiting(ctx, `${incompleteTodos.length} todos remaining`)
    return false
  }

  return true
}

async function areAllChildrenIdle(ctx: RunContext): Promise<boolean> {
  const allStatuses = await fetchAllStatuses(ctx)
  return areAllDescendantsIdle(ctx, ctx.sessionID, allStatuses)
}

async function fetchAllStatuses(
  ctx: RunContext
): Promise<Record<string, SessionStatus>> {
  const statusRes = await ctx.client.session.status({
    query: { directory: ctx.directory },
  })
  return normalizeSDKResponse(statusRes, {} as Record<string, SessionStatus>)
}

async function areAllDescendantsIdle(
  ctx: RunContext,
  sessionID: string,
  allStatuses: Record<string, SessionStatus>
): Promise<boolean> {
  const childrenRes = await ctx.client.session.children({
    path: { id: sessionID },
    query: { directory: ctx.directory },
  })
  const children = normalizeSDKResponse(childrenRes, [] as ChildSession[])

  for (const child of children) {
    const status = allStatuses[child.id]
    if (status && status.type !== "idle") {
      logWaiting(ctx, `session ${child.id.slice(0, 8)}... is ${status.type}`)
      return false
    }

    const descendantsIdle = await areAllDescendantsIdle(
      ctx,
      child.id,
      allStatuses
    )
    if (!descendantsIdle) {
      return false
    }
  }

  return true
}

function logWaiting(ctx: RunContext, message: string): void {
  if (!ctx.verbose) {
    return
  }

  console.log(pc.dim(`  Waiting: ${message}`))
}
