import type { PluginInput } from "@opencode-ai/plugin"
import { resolveBoulderPlanPathForWork } from "@oh-my-opencode/boulder-state"
import { pendingQuestionToolCall } from "@oh-my-opencode/utils"
import { getWorkForSession } from "../../features/boulder-state"
import { resolveMessageEventSessionID, resolveSessionEventID } from "../../shared/event-session-id"
import type { InternalInitiatorTextPartLike } from "../../shared/internal-initiator-marker"
import { isRealUserMessage } from "../../shared/internal-initiator-marker"
import { log } from "../../shared/logger"
import { isRecord } from "../../shared/record-type-guard"
import { compactionGraceTracker, type CompactionGraceTracker } from "../shared/compaction-grace-tracker"
import { createDeferredHumanInputTracker } from "../shared/deferred-human-input"
import { resumeQuestionToolCompletion } from "../shared/human-resume-controller"
import { clearFinalWaveGate } from "./final-wave-gate-store"
import { HOOK_NAME } from "./hook-name"
import { isAbortError } from "./is-abort-error"
import { handleAtlasSessionIdle } from "./idle-event"
import { maybePromoteAtlasQuestionToolWaiting } from "./question-tool-waiting"
import type { AtlasHookOptions, SessionState } from "./types"
import { notifyAtlasWaitingOnHuman } from "./waiting-on-human-gate"

function isEventPart(value: unknown): value is InternalInitiatorTextPartLike {
  if (!isRecord(value)) {
    return false
  }

  const type = value["type"]
  const text = value["text"]
  const synthetic = value["synthetic"]

  return (
    (type === undefined || typeof type === "string") &&
    (text === undefined || typeof text === "string") &&
    (synthetic === undefined || typeof synthetic === "boolean")
  )
}

function resolveQuestionToolCompletion(props: Record<string, unknown> | undefined): string | undefined {
  const part = props?.["part"]
  if (!isRecord(part) || part["type"] !== "tool" || part["tool"] !== "question") {
    return undefined
  }
  const state = part["state"]
  const callID = part["callID"]
  if (!isRecord(state) || state["status"] !== "completed" || typeof callID !== "string") {
    return undefined
  }
  return callID
}

function resolveEventParts(
  properties: Record<string, unknown> | undefined,
): InternalInitiatorTextPartLike[] | undefined {
  const parts = properties?.parts
  if (!Array.isArray(parts) || !parts.every(isEventPart)) {
    return undefined
  }

  return parts
}

function resolveMessageInfo(
  props: Record<string, unknown> | undefined,
): { readonly role?: string; readonly id?: string } | undefined {
  const info = props?.["info"]
  if (!isRecord(info)) {
    return undefined
  }
  const role = info["role"]
  const id = info["id"]
  return {
    ...(typeof role === "string" ? { role } : {}),
    ...(typeof id === "string" ? { id } : {}),
  }
}

export function createAtlasEventHandler(input: {
  ctx: PluginInput
  options?: AtlasHookOptions
  sessions: Map<string, SessionState>
  getState: (sessionID: string) => SessionState
  compactionGraceTracker?: CompactionGraceTracker
}): (arg: { event: { type: string; properties?: unknown } }) => Promise<void> {
  const { ctx, options, sessions, getState } = input
  const humanInputTracker = input.compactionGraceTracker ?? compactionGraceTracker
  const deferredHumanInput = createDeferredHumanInputTracker(humanInputTracker)

  return async ({ event }): Promise<void> => {
    const props = isRecord(event.properties) ? event.properties : undefined

    if (event.type === "session.error") {
      const sessionID = resolveSessionEventID(props)
      if (!sessionID) return

      const state = getState(sessionID)
      const isAbort = isAbortError(props?.error)
      state.lastEventWasAbortError = isAbort

      log(`[${HOOK_NAME}] session.error`, { sessionID, isAbort })
      if (!isAbort) {
        const previousInjectedAt = state.lastContinuationInjectedAt
        await handleAtlasSessionIdle({ ctx, options, getState, sessionID })
        if (
          state.lastContinuationInjectedAt !== undefined
          && state.lastContinuationInjectedAt !== previousInjectedAt
        ) {
          state.skipNextIdleAfterRuntimeErrorRetry = true
        }
      }
      return
    }

    if (event.type === "session.idle") {
      const sessionID = resolveSessionEventID(props)
      if (!sessionID) return
      await handleAtlasSessionIdle({ ctx, options, getState, sessionID })
      return
    }

    if (event.type === "message.updated") {
      const sessionID = resolveMessageEventSessionID(props)
      if (!sessionID) return

      const info = resolveMessageInfo(props)
      const parts = resolveEventParts(props)

      const state = sessions.get(sessionID)
      if (state) {
        state.lastEventWasAbortError = false
        state.skipNextIdleAfterRuntimeErrorRetry = false
      }

      const isPastCompactionGrace = !humanInputTracker.isCompactionGraceActive(sessionID)
      if (isRealUserMessage({ info, parts }) && isPastCompactionGrace) {
        if (state) {
          state.waitingForFinalWaveApproval = false
        }
        const work = getWorkForSession(ctx.directory, sessionID)
        clearFinalWaveGate(ctx.directory, work?.work_id ?? "")
      }
      const messageID = typeof info?.id === "string" ? info.id : undefined
      if (messageID !== undefined && info?.role === "user" && parts === undefined) {
        deferredHumanInput.rememberPending(sessionID, messageID)
      } else if (messageID !== undefined) {
        deferredHumanInput.scheduleIfResumable({
          directory: ctx.directory,
          sessionID,
          messageID,
          message: { info, parts },
        })
      }
      return
    }

    if (event.type === "message.part.updated") {
      const info = isRecord(props?.["info"]) ? props["info"] : undefined
      const sessionID = resolveMessageEventSessionID(props)
      const role = typeof info?.["role"] === "string" ? info["role"] : undefined
      const questionCallID = resolveQuestionToolCompletion(props)
      const part = props?.["part"]
      const pendingQuestion = pendingQuestionToolCall(part)
      const partMessageID = isRecord(part) && typeof part["messageID"] === "string"
        ? part["messageID"]
        : undefined

      if (
        sessionID !== undefined
        && partMessageID !== undefined
        && isEventPart(part)
        && part.type === "text"
        && deferredHumanInput.consumePending(sessionID, partMessageID)
      ) {
        deferredHumanInput.scheduleIfResumable({
          directory: ctx.directory,
          sessionID,
          messageID: partMessageID,
          message: { role: "user", parts: [part] },
        })
      }

      if (sessionID !== undefined && questionCallID !== undefined) {
        await resumeQuestionToolCompletion({
          directory: ctx.directory,
          sessionID,
          questionCallID,
        })
      }

      if (sessionID !== undefined && pendingQuestion !== null) {
        const work = getWorkForSession(ctx.directory, sessionID)
        if (work !== null && await maybePromoteAtlasQuestionToolWaiting({
          ctx,
          sessionID,
          workId: work.work_id,
        })) {
          await notifyAtlasWaitingOnHuman({
            ctx,
            sessionID,
            sessionState: getState(sessionID),
            options,
            planPath: resolveBoulderPlanPathForWork(ctx.directory, work),
            planName: work.plan_name,
            workId: work.work_id,
            settleMs: options?.idleSettleMs,
          })
        }
      }

      if (sessionID && role === "assistant") {
        const state = sessions.get(sessionID)
        if (state) {
          state.lastEventWasAbortError = false
          state.skipNextIdleAfterRuntimeErrorRetry = false
        }
      }
      return
    }

    if (event.type === "tool.execute.before" || event.type === "tool.execute.after") {
      const sessionID = resolveMessageEventSessionID(props)
      if (sessionID) {
        const state = sessions.get(sessionID)
        if (state) {
          state.lastEventWasAbortError = false
          state.skipNextIdleAfterRuntimeErrorRetry = false
        }
      }
      return
    }

    if (event.type === "session.deleted") {
      const sessionID = resolveSessionEventID(props)
      if (sessionID) {
        humanInputTracker.clearSession(sessionID)
        deferredHumanInput.clearSession(sessionID)
        const deletedState = sessions.get(sessionID)
        if (deletedState?.pendingRetryTimer) {
          clearTimeout(deletedState.pendingRetryTimer)
          deletedState.pendingRetryTimer = undefined
        }
        sessions.delete(sessionID)
        log(`[${HOOK_NAME}] Session deleted: cleaned up`, { sessionID })
      }
      return
    }

    if (event.type === "session.compacted") {
      const sessionID = resolveSessionEventID(props)
      if (sessionID) {
        humanInputTracker.recordCompaction(sessionID)
        deferredHumanInput.clearSession(sessionID)
        const compactedState = sessions.get(sessionID)
        if (compactedState?.pendingRetryTimer) {
          clearTimeout(compactedState.pendingRetryTimer)
          compactedState.pendingRetryTimer = undefined
        }
        sessions.delete(sessionID)
        log(`[${HOOK_NAME}] Session compacted: cleaned up`, { sessionID })
      }
    }
  }
}
