import { readFinalWaveGate, writeFinalWaveGate } from "./final-wave-gate-store"
import type { SessionState } from "./types"

const VERDICT_PATTERN = /\bVERDICT:\s*(APPROVE|REJECT)\b/gi

export function classifyFinalWaveVerdict(output: string): "approve" | "reject" | "missing" {
  const verdicts = [...output.matchAll(VERDICT_PATTERN)].map((match) => match[1]?.toLowerCase())
  const hasApprove = verdicts.includes("approve")
  const hasReject = verdicts.includes("reject")

  if (hasApprove && !hasReject) {
    return "approve"
  }

  if (hasReject && !hasApprove) {
    return "reject"
  }

  return "missing"
}

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

  if (classifyFinalWaveVerdict(taskOutput) !== "approve") {
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
