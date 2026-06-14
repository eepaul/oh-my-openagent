import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"

import { getWorkById } from "../../features/boulder-state"
import { writeFileAtomically } from "../../shared/write-file-atomically"
import { readFinalWavePlanState } from "./final-wave-plan-state"

export interface FinalWaveGate {
  work_id: string
  plan_name: string
  approved_count: number
  pending_count: number
  updated_at: string
}

type FinalWaveGateMap = Record<string, FinalWaveGate>

const SIDECAR_DIRECTORY = ".omo"
const SIDECAR_FILENAME = "final-wave-gate.json"

function resolveSidecarPath(directory: string): string {
  return join(directory, SIDECAR_DIRECTORY, SIDECAR_FILENAME)
}

function isFinalWaveGate(value: unknown): value is FinalWaveGate {
  if (typeof value !== "object" || value === null) {
    return false
  }

  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.work_id === "string" &&
    typeof candidate.plan_name === "string" &&
    typeof candidate.approved_count === "number" &&
    typeof candidate.pending_count === "number" &&
    typeof candidate.updated_at === "string"
  )
}

function readGateMap(sidecarPath: string): FinalWaveGateMap | null {
  if (!existsSync(sidecarPath)) {
    return null
  }

  try {
    const raw = readFileSync(sidecarPath, "utf-8")
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null
    }
    return parsed as FinalWaveGateMap
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error
    }
    return null
  }
}

export function readFinalWaveGate(directory: string, workId: string): FinalWaveGate | null {
  const gateMap = readGateMap(resolveSidecarPath(directory))
  if (!gateMap) {
    return null
  }

  const entry = gateMap[workId]
  return isFinalWaveGate(entry) ? entry : null
}

export function writeFinalWaveGate(directory: string, gate: FinalWaveGate): void {
  const sidecarPath = resolveSidecarPath(directory)
  const sidecarDirectory = dirname(sidecarPath)
  if (!existsSync(sidecarDirectory)) {
    mkdirSync(sidecarDirectory, { recursive: true })
  }

  const existingMap = readGateMap(sidecarPath) ?? {}
  const nextMap: FinalWaveGateMap = { ...existingMap, [gate.work_id]: gate }
  writeFileAtomically(sidecarPath, JSON.stringify(nextMap, null, 2))
}

export function clearFinalWaveGate(directory: string, _workId: string): void {
  const sidecarPath = resolveSidecarPath(directory)
  const gateMap = readGateMap(sidecarPath)
  if (!gateMap || !(_workId in gateMap)) {
    return
  }

  delete gateMap[_workId]

  if (Object.keys(gateMap).length === 0) {
    rmSync(sidecarPath, { force: true })
    return
  }

  writeFileAtomically(sidecarPath, JSON.stringify(gateMap, null, 2))
}

function gateAwaitsApproval(gate: FinalWaveGate | null | undefined): boolean {
  if (!gate) {
    return false
  }
  return gate.pending_count > 0 && gate.approved_count < gate.pending_count
}

function isAwaitingFinalWaveApprovalForWork(directory: string, workId: string, planPath: string): boolean {
  const gate = readFinalWaveGate(directory, workId)
  if (!gate) {
    return false
  }

  const planState = readFinalWavePlanState(planPath)
  if (!planState) {
    return false
  }

  const planAwaitsFinalWave =
    planState.pendingImplementationTaskCount === 0 && planState.pendingFinalWaveTaskCount > 0
  if (!planAwaitsFinalWave) {
    // The plan moved out of the final-wave-pending shape: either the final-wave
    // boxes were checked (pendingFinalWaveTaskCount === 0) or implementation was
    // reopened (pendingImplementationTaskCount > 0). The durable gate is stale.
    clearFinalWaveGate(directory, workId)
    return false
  }

  const work = getWorkById(directory, workId)
  if (!work || work.plan_name !== gate.plan_name) {
    return false
  }

  return gateAwaitsApproval(gate)
}

export function isAwaitingFinalWaveApproval(gate: FinalWaveGate | null | undefined): boolean
export function isAwaitingFinalWaveApproval(directory: string, workId: string, planPath: string): boolean
export function isAwaitingFinalWaveApproval(
  gateOrDirectory: FinalWaveGate | null | undefined | string,
  workId?: string,
  planPath?: string,
): boolean {
  if (typeof gateOrDirectory === "string") {
    return isAwaitingFinalWaveApprovalForWork(gateOrDirectory, workId ?? "", planPath ?? "")
  }
  return gateAwaitsApproval(gateOrDirectory)
}
