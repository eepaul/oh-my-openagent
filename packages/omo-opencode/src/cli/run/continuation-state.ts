import { normalizeSessionId, readBoulderState, resolveBoulderPlanPath } from "../../features/boulder-state"
import { getPlanChecklist, isPlanLifecycleComplete, isPlanWaitingOnHuman } from "@oh-my-opencode/boulder-state"
import { getSessionAgent } from "../../features/claude-code-session-state"
import {
  getActiveContinuationMarkerReason,
  isContinuationMarkerActive,
  readContinuationMarker,
} from "../../features/run-continuation-state"
import { isSessionInBoulderLineage } from "../../hooks/atlas/boulder-session-lineage"
import { getLastAgentFromSession } from "../../hooks/atlas/session-last-agent"
import { getAgentConfigKey } from "../../shared/agent-display-names"
import { readState as readRalphLoopState } from "../../hooks/ralph-loop/storage"
import type { RunContext } from "./types"

export interface ContinuationState {
  hasActiveBoulder: boolean
  hasActiveRalphLoop: boolean
  hasHookMarker: boolean
  hasTodoHookMarker: boolean
  hasActiveBackgroundTaskMarker: boolean
  hasActiveHookMarker: boolean
  activeHookMarkerReason: string | null
  boulderContinuation: BoulderContinuationClassification
}

export interface WaitingBoulderContinuation {
  readonly planName: string
  readonly blockedCount: number
}

export type BoulderContinuationClassification =
  | "none"
  | "active"
  | { readonly waiting: WaitingBoulderContinuation }

export async function getContinuationState(
  directory: string,
  sessionID: string,
  client?: RunContext["client"],
): Promise<ContinuationState> {
  const marker = readContinuationMarker(directory, sessionID)
  const boulderContinuation = await classifyBoulderContinuation(directory, sessionID, client)

  return {
    hasActiveBoulder: boulderContinuation === "active",
    hasActiveRalphLoop: hasActiveRalphLoopContinuation(directory, sessionID),
    hasHookMarker: marker !== null,
    hasTodoHookMarker: marker?.sources.todo !== undefined,
    hasActiveBackgroundTaskMarker: marker?.sources["background-task"]?.state === "active",
    hasActiveHookMarker: isContinuationMarkerActive(marker),
    activeHookMarkerReason: getActiveContinuationMarkerReason(marker),
    boulderContinuation,
  }
}

export async function classifyBoulderContinuation(
  directory: string,
  sessionID: string,
  client?: RunContext["client"],
): Promise<BoulderContinuationClassification> {
  const boulder = readBoulderState(directory)
  if (!boulder || !client) return "none"

  const normalizedSessionID = normalizeSessionId(sessionID)
  const normalizedTrackedSessionIDs = boulder.session_ids.map((trackedSessionID) => normalizeSessionId(trackedSessionID))
  if (!normalizedTrackedSessionIDs.includes(normalizedSessionID)) {
    return "none"
  }

  const sessionOrigin = boulder.session_origins?.[sessionID] ?? boulder.session_origins?.[normalizedSessionID]
  if (sessionOrigin === "direct") {
    return classifyBoundBoulderContinuation(directory, boulder)
  }

  const trackedAncestorSessionIDs = normalizedTrackedSessionIDs
    .filter((trackedSessionID) => trackedSessionID !== normalizedSessionID)
  if (trackedAncestorSessionIDs.length === 0) {
    return classifyBoundBoulderContinuation(directory, boulder)
  }

  const isTrackedDescendant = await isTrackedDescendantSession(client, sessionID, trackedAncestorSessionIDs)
  if (!isTrackedDescendant) {
    return "none"
  }

  const sessionAgent = await getLastAgentFromSession(sessionID, client)
    ?? getSessionAgent(sessionID)
  if (!sessionAgent) {
    return "none"
  }

  const requiredAgentKey = getAgentConfigKey(boulder.agent ?? "atlas")
  const sessionAgentKey = getAgentConfigKey(sessionAgent)
  if (
    sessionAgentKey !== requiredAgentKey
    && !(requiredAgentKey === getAgentConfigKey("atlas") && sessionAgentKey === getAgentConfigKey("sisyphus"))
  ) {
    return "none"
  }

  return classifyBoundBoulderContinuation(directory, boulder)
}

function classifyBoundBoulderContinuation(
  directory: string,
  boulder: NonNullable<ReturnType<typeof readBoulderState>>,
): BoulderContinuationClassification {
  const planPath = resolveBoulderPlanPath(directory, boulder)
  if (isPlanWaitingOnHuman(planPath)) {
    return {
      waiting: {
        planName: boulder.plan_name,
        blockedCount: getPlanChecklist(planPath).blocked ?? 0,
      },
    }
  }

  return isPlanLifecycleComplete(planPath) ? "none" : "active"
}

async function isTrackedDescendantSession(
  client: RunContext["client"],
  sessionID: string,
  trackedAncestorSessionIDs: string[],
): Promise<boolean> {
  if (trackedAncestorSessionIDs.length === 0) {
    return false
  }

  return isSessionInBoulderLineage({
    client,
    sessionID,
    boulderSessionIDs: trackedAncestorSessionIDs,
  })
}

function hasActiveRalphLoopContinuation(directory: string, sessionID: string): boolean {
  const state = readRalphLoopState(directory)
  if (!state || !state.active) return false

  if (state.session_id && state.session_id !== sessionID) {
    return false
  }

  return true
}
