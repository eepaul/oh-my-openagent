import { readFinalWaveGate, writeFinalWaveGate } from "./final-wave-gate-store"
import type { SessionState } from "./types"

const APPROVE_VERDICT_PATTERN = /\bVERDICT:\s*APPROVE\b/i

export function shouldPauseForFinalWaveApproval(input: {
  directory: string
  workId: string
  planName: string
  pendingCount: number
  taskOutput: string
  sessionState: SessionState
}): boolean {
  const { directory, workId, planName, pendingCount, taskOutput } = input

  if (pendingCount <= 0) {
    return false
  }

  if (!APPROVE_VERDICT_PATTERN.test(taskOutput)) {
    return false
  }

  const updatedAt = new Date().toISOString()

  if (pendingCount === 1) {
    writeFinalWaveGate(directory, {
      work_id: workId,
      plan_name: planName,
      approved_count: 1,
      pending_count: 1,
      updated_at: updatedAt,
    })
    return true
  }

  const existingGate = readFinalWaveGate(directory, workId)
  const continuesCurrentBatch =
    existingGate !== null
    && existingGate.plan_name === planName
    && existingGate.pending_count === pendingCount
  const approvedCount = continuesCurrentBatch ? existingGate.approved_count + 1 : 1

  writeFinalWaveGate(directory, {
    work_id: workId,
    plan_name: planName,
    approved_count: approvedCount,
    pending_count: pendingCount,
    updated_at: updatedAt,
  })

  return approvedCount >= pendingCount
}
