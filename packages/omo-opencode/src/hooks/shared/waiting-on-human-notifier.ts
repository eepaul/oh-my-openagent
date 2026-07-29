import {
  createInternalAgentContinuationTextPart,
} from "../../shared"
import { isAmbiguousPostDispatchPromptFailure } from "../../shared/prompt-failure-classifier"
import {
  dispatchInternalPrompt,
  type InternalPromptDispatchArgs,
  type InternalPromptDispatchResult,
} from "../../shared/prompt-async-gate"
import { WAITING_ON_HUMAN_PROMPT } from "../atlas/system-reminder-templates"

type WaitingOnHumanPromptInput = {
  readonly path: { readonly id: string }
  readonly body: { readonly parts: readonly ReturnType<typeof createInternalAgentContinuationTextPart>[] }
  readonly query: { readonly directory: string }
}

type WaitingOnHumanPromptDispatchArgs = Extract<
  InternalPromptDispatchArgs<WaitingOnHumanPromptInput>,
  { readonly mode: "async" }
>

export type WaitingOnHumanNotifier = {
  readonly maybeNotify: (
    input: WaitingOnHumanNotificationInput,
  ) => Promise<InternalPromptDispatchResult | null>
  readonly reset: (sessionID: string) => void
}

export type WaitingOnHumanNotificationInput = {
  readonly client: WaitingOnHumanPromptDispatchArgs["client"]
  readonly directory: string
  readonly sessionID: string
  readonly planPath: string
  readonly planName: string
  readonly blockedCount: number
  readonly preDispatchGuard: () => boolean
  readonly settleMs?: number
}

type WaitingOnHumanNotifierDependencies = {
  readonly dispatchInternalPrompt?: (
    args: WaitingOnHumanPromptDispatchArgs,
  ) => Promise<InternalPromptDispatchResult>
}

const WAITING_ON_HUMAN_SOURCE = "waiting-on-human-notifier"

function createWaitingEpisodeKey(planPath: string, blockedCount: number): string {
  return JSON.stringify([planPath, blockedCount])
}

function shouldKeepWaitingEpisodeReservation(result: InternalPromptDispatchResult): boolean {
  switch (result.status) {
    case "dispatched":
    case "queued":
      return true
    case "failed":
      return isAmbiguousPostDispatchPromptFailure(result)
    case "active":
    case "reserved":
    case "unavailable":
    case "guard_rejected":
      return false
    default: {
      const unreachable: never = result
      return unreachable
    }
  }
}

export function createWaitingOnHumanNotifier(
  dependencies: WaitingOnHumanNotifierDependencies = {},
): WaitingOnHumanNotifier {
  const reservedEpisodesBySession = new Map<string, Set<string>>()
  const promptDispatcher = dependencies.dispatchInternalPrompt ?? dispatchInternalPrompt

  function reserve(sessionID: string, episodeKey: string): boolean {
    let reservedEpisodes = reservedEpisodesBySession.get(sessionID)
    if (reservedEpisodes?.has(episodeKey)) {
      return false
    }
    if (reservedEpisodes === undefined) {
      reservedEpisodes = new Set<string>()
      reservedEpisodesBySession.set(sessionID, reservedEpisodes)
    }
    reservedEpisodes.add(episodeKey)
    return true
  }

  function release(sessionID: string, episodeKey: string): void {
    const reservedEpisodes = reservedEpisodesBySession.get(sessionID)
    if (reservedEpisodes === undefined) {
      return
    }
    reservedEpisodes.delete(episodeKey)
    if (reservedEpisodes.size === 0) {
      reservedEpisodesBySession.delete(sessionID)
    }
  }

  return {
    maybeNotify: async (input) => {
      const episodeKey = createWaitingEpisodeKey(input.planPath, input.blockedCount)
      if (!reserve(input.sessionID, episodeKey)) {
        return null
      }

      const prompt = WAITING_ON_HUMAN_PROMPT
        .replaceAll("{PLAN_NAME}", input.planName)
        .replaceAll("{BLOCKED_COUNT}", String(input.blockedCount))
      const result = await promptDispatcher({
        mode: "async",
        client: input.client,
        sessionID: input.sessionID,
        source: WAITING_ON_HUMAN_SOURCE,
        queueBehavior: "defer",
        preDispatchGuard: input.preDispatchGuard,
        ...(input.settleMs === undefined ? {} : { settleMs: input.settleMs }),
        input: {
          path: { id: input.sessionID },
          body: { parts: [createInternalAgentContinuationTextPart(prompt)] },
          query: { directory: input.directory },
        },
      })
      if (!shouldKeepWaitingEpisodeReservation(result)) {
        release(input.sessionID, episodeKey)
      }
      return result
    },
    reset: (sessionID) => {
      reservedEpisodesBySession.delete(sessionID)
    },
  }
}
