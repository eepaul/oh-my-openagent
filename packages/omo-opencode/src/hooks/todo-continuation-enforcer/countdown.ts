import type { PluginInput } from "@opencode-ai/plugin"

import type { BackgroundManager } from "../../features/background-agent"
import { log } from "../../shared/logger"
import type { WaitingOnHumanNotifier } from "../shared/waiting-on-human-notifier"

import {
  COUNTDOWN_SECONDS,
  HOOK_NAME,
  TOAST_DURATION_MS,
} from "./constants"
import { systemCountdownScheduler } from "./countdown-scheduler"
import type { CountdownScheduler, ResolvedMessageInfo } from "./types"
import type { SessionStateStore } from "./session-state"
import { injectContinuation } from "./continuation-injection"
import { getWaitingOnHumanPlanForSession, notifyWaitingOnHuman } from "./waiting-on-human-plan"

async function showCountdownToast(
  ctx: PluginInput,
  seconds: number,
  incompleteCount: number
): Promise<void> {
  await ctx.client.tui
    .showToast({
      body: {
        title: "Todo Continuation",
        message: `Resuming in ${seconds}s... (${incompleteCount} tasks remaining)`,
        variant: "warning" as const,
        duration: TOAST_DURATION_MS,
      },
    })
    .catch(() => {})
}

export function startCountdown(args: {
  ctx: PluginInput
  sessionID: string
  incompleteCount: number
  total: number
  resolvedInfo?: ResolvedMessageInfo
  backgroundManager?: BackgroundManager
  skipAgents: string[]
  sessionStateStore: SessionStateStore
  isContinuationStopped?: (sessionID: string) => boolean
  waitingOnHumanNotifier?: WaitingOnHumanNotifier
  countdownScheduler?: CountdownScheduler
}): void {
  const {
    ctx,
    sessionID,
    incompleteCount,
    resolvedInfo,
    backgroundManager,
    skipAgents,
    sessionStateStore,
    isContinuationStopped,
    waitingOnHumanNotifier,
    countdownScheduler: requestedScheduler,
  } = args

  const state = sessionStateStore.getState(sessionID)
  const countdownScheduler = requestedScheduler
    ?? sessionStateStore.countdownScheduler
    ?? systemCountdownScheduler
  sessionStateStore.cancelCountdown(sessionID)

  let secondsRemaining = COUNTDOWN_SECONDS
  showCountdownToast(ctx, secondsRemaining, incompleteCount)
  state.countdownStartedAt = Date.now()

  state.countdownInterval = countdownScheduler.setInterval(() => {
    secondsRemaining--
    if (secondsRemaining > 0) {
      showCountdownToast(ctx, secondsRemaining, incompleteCount)
    }
  }, 1000)

  state.countdownTimer = countdownScheduler.setTimeout(async () => {
    sessionStateStore.cancelCountdown(sessionID)
    if (isContinuationStopped?.(sessionID)) {
      log(`[${HOOK_NAME}] Countdown skipped: continuation stopped for session`, { sessionID })
      return
    }

    const waitingPlan = await getWaitingOnHumanPlanForSession(ctx.directory, sessionID)
    if (waitingPlan) {
      await notifyWaitingOnHuman({
        ctx,
        sessionID,
        waitingPlan,
        notifier: waitingOnHumanNotifier,
        isContinuationStopped,
      })
      log(`[${HOOK_NAME}] Countdown skipped: boulder plan waiting on a human decision`, {
        sessionID,
        planPath: waitingPlan.planPath,
        blockedCount: waitingPlan.blockedCount,
      })
      return
    }

    await injectContinuation({
      ctx,
      sessionID,
      backgroundManager,
      skipAgents,
      resolvedInfo,
      sessionStateStore,
      isContinuationStopped,
      waitingOnHumanNotifier,
    })
  }, COUNTDOWN_SECONDS * 1000)

  log(`[${HOOK_NAME}] Countdown started`, {
    sessionID,
    seconds: COUNTDOWN_SECONDS,
    incompleteCount,
  })
}
