import { mock } from "bun:test"
import type { PendingCall } from "./types"

type InitializeCommentCheckerCli = typeof import("./cli-runner").initializeCommentCheckerCli
type GetCommentCheckerCliPathPromise = typeof import("./cli-runner").getCommentCheckerCliPathPromise
type IsCliPathUsable = typeof import("./cli-runner").isCliPathUsable
type ProcessWithCli = typeof import("./cli-runner").processWithCli
type ProcessApplyPatchEditsWithCli = typeof import("./cli-runner").processApplyPatchEditsWithCli
type RegisterPendingCall = typeof import("./pending-calls").registerPendingCall
type TakePendingCall = typeof import("./pending-calls").takePendingCall
type StartPendingCallCleanup = typeof import("./pending-calls").startPendingCallCleanup
type StopPendingCallCleanup = typeof import("./pending-calls").stopPendingCallCleanup

const pendingCalls = new Map<string, PendingCall>()

export const initializeCommentCheckerCli = mock<InitializeCommentCheckerCli>(() => {})
export const getCommentCheckerCliPathPromise = mock<GetCommentCheckerCliPathPromise>(() =>
  Promise.resolve("/tmp/fake-comment-checker"),
)
export const isCliPathUsable = mock<IsCliPathUsable>((cliPath): cliPath is string => true)
export const processWithCli = mock<ProcessWithCli>(async () => {})
export const processApplyPatchEditsWithCli = mock<ProcessApplyPatchEditsWithCli>(async () => {})
export const startPendingCallCleanup = mock<StartPendingCallCleanup>(() => {})
export const stopPendingCallCleanup = mock<StopPendingCallCleanup>(() => {
  pendingCalls.clear()
})
export const registerPendingCall = mock<RegisterPendingCall>((callID, pendingCall) => {
  pendingCalls.set(callID, pendingCall)
})
export const takePendingCall = mock<TakePendingCall>((callID) => {
  const pendingCall = pendingCalls.get(callID)
  if (pendingCall === undefined) return undefined
  pendingCalls.delete(callID)
  return pendingCall
})

mock.module("./cli-runner", () => ({
  initializeCommentCheckerCli,
  getCommentCheckerCliPathPromise,
  isCliPathUsable,
  processWithCli,
  processApplyPatchEditsWithCli,
}))

mock.module("./pending-calls", () => ({
  registerPendingCall,
  startPendingCallCleanup,
  stopPendingCallCleanup,
  takePendingCall,
}))

export function clearCommentCheckerTestMocks(): void {
  pendingCalls.clear()
  initializeCommentCheckerCli.mockClear()
  getCommentCheckerCliPathPromise.mockClear()
  isCliPathUsable.mockClear()
  processWithCli.mockClear()
  processApplyPatchEditsWithCli.mockClear()
  startPendingCallCleanup.mockClear()
  stopPendingCallCleanup.mockClear()
  registerPendingCall.mockClear()
  takePendingCall.mockClear()
}
