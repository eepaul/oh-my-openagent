import { getBoulderWorks, normalizeSessionId, readBoulderState } from "../../features/boulder-state"
import {
  checkPlanWaiting,
  getPlanChecklist,
  isPlanLifecycleComplete,
  resolveBoulderPlanPathForWork,
} from "@oh-my-opencode/boulder-state"
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
import type { BoulderWorkState } from "../../features/boulder-state"
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

  const works = getBoulderWorks(boulder)
  const activeWork = boulder.active_work_id === undefined
    ? undefined
    : works.find((candidate) => candidate.work_id === boulder.active_work_id)
  const [firstWork] = works
  const work = activeWork ?? firstWork
  if (!work) return "none"

  const normalizedSessionID = normalizeSessionId(sessionID)
  const normalizedTrackedSessionIDs = work.session_ids.map((trackedSessionID) => normalizeSessionId(trackedSessionID))
  if (!normalizedTrackedSessionIDs.includes(normalizedSessionID)) {
    return "none"
  }

  const sessionOrigin = work.session_origins?.[sessionID] ?? work.session_origins?.[normalizedSessionID]
  if (sessionOrigin === "direct") {
    return classifyBoundBoulderContinuation(directory, work)
  }

  const trackedAncestorSessionIDs = normalizedTrackedSessionIDs
    .filter((trackedSessionID) => trackedSessionID !== normalizedSessionID)
  if (trackedAncestorSessionIDs.length === 0) {
    return classifyBoundBoulderContinuation(directory, work)
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

  const requiredAgentKey = getAgentConfigKey(work.agent ?? "atlas")
  const sessionAgentKey = getAgentConfigKey(sessionAgent)
  if (
    sessionAgentKey !== requiredAgentKey
    && !(requiredAgentKey === getAgentConfigKey("atlas") && sessionAgentKey === getAgentConfigKey("sisyphus"))
  ) {
    return "none"
  }

  return classifyBoundBoulderContinuation(directory, work)
}

function classifyBoundBoulderContinuation(
  directory: string,
  work: BoulderWorkState,
): BoulderContinuationClassification {
  const planPath = resolveBoulderPlanPathForWork(directory, work)
  if (checkPlanWaiting(directory, work).waiting) {
    return {
      waiting: {
        planName: work.plan_name,
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
