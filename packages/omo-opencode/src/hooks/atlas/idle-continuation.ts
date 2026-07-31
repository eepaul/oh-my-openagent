import type { PluginInput } from "@opencode-ai/plugin"
import { checkPlanWaiting } from "@oh-my-opencode/boulder-state"
import {
  getPlanProgress,
  getTaskSessionState,
  getWorkForSession,
  normalizeSessionId,
  readBoulderState,
  readCurrentTopLevelTask,
  resolveBoulderPlanPath,
} from "../../features/boulder-state"
import { log } from "../../shared/logger"
import { checkWorkWaiting } from "../shared/check-work-waiting"
import { isFailClosed } from "../shared/waiting-fail-closed-gate"
import { injectBoulderContinuation } from "./boulder-continuation-injector"
import { HOOK_NAME } from "./hook-name"
import {
  CONTINUATION_COOLDOWN_MS,
  MAX_CONSECUTIVE_PROMPT_FAILURES,
  RETRY_DELAY_MS,
} from "./idle-constants"
import { canContinueTrackedBoulderSession } from "./idle-session-eligibility"
import { clearPendingRetryTimer } from "./retry-timer"
import type { AtlasHookOptions, SessionState } from "./types"
import { notifyAtlasWaitingOnHuman } from "./waiting-on-human-gate"

const ACTIVE_BACKGROUND_TASK_STATUSES = new Set(["pending", "running"])

export function hasRunningBackgroundTasks(sessionID: string, options?: AtlasHookOptions): boolean {
  const backgroundManager = options?.backgroundManager
  return backgroundManager
    ? backgroundManager
        .getTasksByParentSession(sessionID)
        .some((task: { status: string }) => ACTIVE_BACKGROUND_TASK_STATUSES.has(task.status))
    : false
}

export async function injectContinuation(input: {
  ctx: PluginInput
  sessionID: string
  sessionState: SessionState
  options?: AtlasHookOptions
  planName: string
  progress: { total: number; completed: number }
  agent?: string
  worktreePath?: string
  idleSettleMs?: number
}): Promise<void> {
  const remaining = input.progress.total - input.progress.completed
  if (input.options?.isContinuationStopped?.(input.sessionID)) {
    clearPendingRetryTimer(input.sessionState)
    log(`[${HOOK_NAME}] Skipped injection: continuation stopped for session`, { sessionID: input.sessionID })
    return
  }

  if (input.sessionState.isInjectingContinuation) {
    scheduleRetry({
      ctx: input.ctx,
      sessionID: input.sessionID,
      sessionState: input.sessionState,
      options: input.options,
    })
    return
  }

  input.sessionState.isInjectingContinuation = true

  try {
    const currentBoulder = readBoulderState(input.ctx.directory)
    const normalizedSessionID = normalizeSessionId(input.sessionID)
    const currentPlanPath = currentBoulder
      ? resolveBoulderPlanPath(input.ctx.directory, currentBoulder)
      : null
    const currentTask = currentBoulder
      && currentPlanPath
      ? readCurrentTopLevelTask(currentPlanPath)
      : null
    const preferredTaskSession = currentTask
      ? getTaskSessionState(input.ctx.directory, currentTask.key)
      : null

    if (!currentBoulder) {
      return
    }
    const waitingWorkId = currentBoulder.active_work_id
      ?? getWorkForSession(input.ctx.directory, input.sessionID)?.work_id

    if (input.options?.isContinuationStopped?.(input.sessionID)) {
      clearPendingRetryTimer(input.sessionState)
      log(`[${HOOK_NAME}] Skipped injection: continuation stopped for session`, { sessionID: input.sessionID })
      return
    }

    if (currentPlanPath && waitingWorkId && await checkWorkWaiting(input.ctx.directory, waitingWorkId)) {
      await notifyAtlasWaitingOnHuman({
        ctx: input.ctx,
        sessionID: input.sessionID,
        sessionState: input.sessionState,
        options: input.options,
        planPath: currentPlanPath,
        planName: currentBoulder.plan_name,
        workId: waitingWorkId,
        settleMs: input.idleSettleMs,
      })
      return
    }
    input.options?.waitingOnHumanNotifier?.reset(input.sessionID)

    const canContinueSession = await canContinueTrackedBoulderSession({
      client: input.ctx.client,
      sessionID: input.sessionID,
      sessionOrigin: currentBoulder.session_origins?.[normalizedSessionID],
      boulderSessionIDs: currentBoulder.session_ids,
      requiredAgent: currentBoulder.agent,
    })
    if (!canContinueSession) {
      log(`[${HOOK_NAME}] Skipped: tracked descendant agent does not match boulder agent`, {
        sessionID: input.sessionID,
        requiredAgent: currentBoulder.agent ?? "atlas",
      })
      return
    }

    const result = await injectBoulderContinuation({
      ctx: input.ctx,
      sessionID: input.sessionID,
      planName: input.planName,
      remaining,
      total: input.progress.total,
      agent: input.agent,
      worktreePath: input.worktreePath,
      preferredTaskSessionId: preferredTaskSession?.session_id,
      preferredTaskTitle: preferredTaskSession?.task_title,
      backgroundManager: input.options?.backgroundManager,
      sessionState: input.sessionState,
      idleSettleMs: input.idleSettleMs,
      preDispatchGuard: () => {
        const freshBoulder = readBoulderState(input.ctx.directory)
        const freshWorkId = freshBoulder?.active_work_id
          ?? getWorkForSession(input.ctx.directory, input.sessionID)?.work_id
        const freshWork = freshWorkId === undefined
          ? null
          : getWorkForSession(input.ctx.directory, input.sessionID)
        return !input.options?.isContinuationStopped?.(input.sessionID)
          && freshWork !== null
          && !isFailClosed(input.ctx.directory, freshWork.work_id)
          && !checkPlanWaiting(input.ctx.directory, freshWork).waiting
      },
    })

    if (result === "injected") {
      if (input.sessionState.pendingRetryTimer) {
        clearTimeout(input.sessionState.pendingRetryTimer)
        input.sessionState.pendingRetryTimer = undefined
      }
      input.sessionState.lastContinuationInjectedAt = Date.now()
      return
    }

    if (result === "skipped_background_tasks") {
      scheduleRetry({
        ctx: input.ctx,
        sessionID: input.sessionID,
        sessionState: input.sessionState,
        options: input.options,
      })
      return
    }

    if (result === "skipped_active_session") {
      scheduleRetry({
        ctx: input.ctx,
        sessionID: input.sessionID,
        sessionState: input.sessionState,
        options: input.options,
      })
      return
    }

    if (result === "failed") {
      scheduleRetry({
        ctx: input.ctx,
        sessionID: input.sessionID,
        sessionState: input.sessionState,
        options: input.options,
      })
    }
  } catch (error) {
    const loggedError = error instanceof Error ? error : String(error)
    log(`[${HOOK_NAME}] Failed to inject boulder continuation`, { sessionID: input.sessionID, error: loggedError })
    input.sessionState.promptFailureCount += 1
    input.sessionState.lastFailureAt = Date.now()
    scheduleRetry({
      ctx: input.ctx,
      sessionID: input.sessionID,
      sessionState: input.sessionState,
      options: input.options,
    })
  } finally {
    input.sessionState.isInjectingContinuation = false
  }
}

export function scheduleRetry(input: {
  ctx: PluginInput
  sessionID: string
  sessionState: SessionState
  options?: AtlasHookOptions
}): void {
  const { ctx, sessionID, sessionState, options } = input
  if (sessionState.pendingRetryTimer) {
    return
  }

  sessionState.pendingRetryTimer = setTimeout(async () => {
    try {
      sessionState.pendingRetryTimer = undefined

      if (sessionState.promptFailureCount >= MAX_CONSECUTIVE_PROMPT_FAILURES) return
      if (sessionState.stalledContinuationReason) return
      if (sessionState.waitingForFinalWaveApproval) return

      const now = Date.now()
      if (
        sessionState.lastContinuationInjectedAt
        && now - sessionState.lastContinuationInjectedAt < CONTINUATION_COOLDOWN_MS
      ) {
        return
      }

      const currentBoulder = readBoulderState(ctx.directory)
      if (!currentBoulder) return
      const normalizedSessionID = normalizeSessionId(sessionID)
      if (!currentBoulder.session_ids?.includes(normalizedSessionID)) return

      const currentPlanPath = resolveBoulderPlanPath(ctx.directory, currentBoulder)
      const waitingWorkId = currentBoulder.active_work_id
        ?? getWorkForSession(ctx.directory, sessionID)?.work_id
      if (options?.isContinuationStopped?.(sessionID)) return
      if (waitingWorkId && await checkWorkWaiting(ctx.directory, waitingWorkId)) {
        await notifyAtlasWaitingOnHuman({
          ctx,
          sessionID,
          sessionState,
          options,
          planPath: currentPlanPath,
          planName: currentBoulder.plan_name,
          workId: waitingWorkId,
        })
        return
      }
      options?.waitingOnHumanNotifier?.reset(sessionID)

      const currentProgress = getPlanProgress(currentPlanPath)
      if (currentProgress.isComplete) return
      const canContinueSession = await canContinueTrackedBoulderSession({
        client: ctx.client,
        sessionID,
        sessionOrigin: currentBoulder.session_origins?.[normalizedSessionID],
        boulderSessionIDs: currentBoulder.session_ids,
        requiredAgent: currentBoulder.agent,
      })
      if (!canContinueSession) return
      if (hasRunningBackgroundTasks(sessionID, options)) {
        scheduleRetry({ ctx, sessionID, sessionState, options })
        return
      }

      await injectContinuation({
        ctx,
        sessionID,
        sessionState,
        options,
        planName: currentBoulder.plan_name,
        progress: currentProgress,
        agent: currentBoulder.agent,
        worktreePath: currentBoulder.worktree_path,
      })
    } catch (error) {
      const loggedError = error instanceof Error ? error : String(error)
      log(`[${HOOK_NAME}] Failed during boulder continuation retry`, { sessionID, error: loggedError })
      sessionState.promptFailureCount += 1
      sessionState.lastFailureAt = Date.now()
      scheduleRetry({ ctx, sessionID, sessionState, options })
    }
  }, RETRY_DELAY_MS)
}
