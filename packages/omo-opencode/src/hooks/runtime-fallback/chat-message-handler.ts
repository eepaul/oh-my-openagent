import type { HookDeps } from "./types"
import { HOOK_NAME } from "./constants"
import { log } from "../../shared/logger"
import { parseModelString } from "../../shared/model-string-parser"
import { areRuntimeModelsEquivalent, createFallbackState, isModelInCooldown } from "./fallback-state"

function applyModelOverride(
  message: { model?: { providerID: string; modelID: string }; variant?: string },
  activeModel: string,
): void {
  const parsed = parseModelString(activeModel)
  if (!parsed) return
  message.model = { providerID: parsed.providerID, modelID: parsed.modelID }
  if (parsed.variant !== undefined) {
    message.variant = parsed.variant
  } else {
    delete message.variant
  }
}

export function createChatMessageHandler(deps: HookDeps) {
  const { config, sessionStates, sessionLastAccess } = deps

  return async (
    input: { sessionID: string; agent?: string; model?: { providerID: string; modelID: string } },
    output: { message: { model?: { providerID: string; modelID: string }; variant?: string }; parts?: Array<{ type: string; text?: string }> }
  ) => {
    if (!config.enabled) return

    const { sessionID } = input
    let state = sessionStates.get(sessionID)

    if (!state) return

    sessionLastAccess.set(sessionID, Date.now())

    const requestedModel = input.model
      ? `${input.model.providerID}/${input.model.modelID}`
      : undefined

    if (requestedModel) {
      if (state.pendingFallbackModel && areRuntimeModelsEquivalent(state.pendingFallbackModel, requestedModel)) {
        state.pendingFallbackModel = undefined
        state.pendingFallbackPromptMayHaveBeenAccepted = false
        return
      }

      if (!areRuntimeModelsEquivalent(requestedModel, state.currentModel)) {
        log(`[${HOOK_NAME}] Detected manual model change, resetting fallback state`, {
          sessionID,
          from: state.currentModel,
          to: requestedModel,
        })
        state = createFallbackState(requestedModel)
        sessionStates.set(sessionID, state)
        return
      }
    }

    if (
      config.restore_primary_after_cooldown &&
      !areRuntimeModelsEquivalent(state.currentModel, state.originalModel) &&
      !state.pendingFallbackModel &&
      !isModelInCooldown(state.originalModel, state, config.cooldown_seconds)
    ) {
      const activeModel = state.originalModel
      log(`[${HOOK_NAME}] Restoring preferred primary model`, {
        sessionID,
        from: state.currentModel,
        to: activeModel,
      })
      sessionStates.set(sessionID, createFallbackState(activeModel))

      applyModelOverride(output.message, activeModel)
      return
    }

    const activeModel = state.currentModel

    if (areRuntimeModelsEquivalent(activeModel, state.originalModel)) return

    log(`[${HOOK_NAME}] Applying fallback model override`, {
      sessionID,
      from: input.model,
      to: activeModel,
    })

    if (output.message && activeModel) {
      applyModelOverride(output.message, activeModel)
    }
  }
}
