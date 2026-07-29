import type { PluginInput } from "@opencode-ai/plugin"
import { getPlanChecklist, isPlanWaitingOnHuman } from "@oh-my-opencode/boulder-state"
import type { WaitingOnHumanNotificationInput } from "../shared/waiting-on-human-notifier"
import { clearPendingRetryTimer } from "./retry-timer"
import type { AtlasHookOptions, SessionState } from "./types"

function createWaitingOnHumanClient(
  ctx: PluginInput,
): WaitingOnHumanNotificationInput["client"] {
  return {
    session: {
      status: async () => ctx.client.session.status(),
      messages: async (input) => ctx.client.session.messages({
        path: { ...input.path },
        query: { ...input.query },
      }),
      promptAsync: async (input) => ctx.client.session.promptAsync({
        path: { ...input.path },
        body: { ...input.body, parts: [...input.body.parts] },
        query: { ...input.query },
      }),
    },
  }
}

export async function notifyAtlasWaitingOnHuman(input: {
  readonly ctx: PluginInput
  readonly sessionID: string
  readonly sessionState: SessionState
  readonly options?: AtlasHookOptions
  readonly planPath: string
  readonly planName: string
  readonly settleMs?: number
}): Promise<void> {
  clearPendingRetryTimer(input.sessionState)

  await input.options?.waitingOnHumanNotifier?.maybeNotify({
    client: createWaitingOnHumanClient(input.ctx),
    directory: input.ctx.directory,
    sessionID: input.sessionID,
    planPath: input.planPath,
    planName: input.planName,
    blockedCount: getPlanChecklist(input.planPath).blocked ?? 0,
    preDispatchGuard: () =>
      !input.options?.isContinuationStopped?.(input.sessionID)
      && isPlanWaitingOnHuman(input.planPath),
    ...(input.settleMs === undefined ? {} : { settleMs: input.settleMs }),
  })
}
