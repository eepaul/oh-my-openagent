import { isPlainRecord } from "@oh-my-opencode/utils"
import {
  loadOmoConfig,
  mergeOmoConfigRecords,
  OmoConfigSchema,
  type OmoAgentDef,
  type OmoAgentModelEntry,
  type OmoConfigEnv,
  type OmoReasoning,
  resolveModelReferences,
  resolveOmoConfigView,
} from "@oh-my-opencode/omo-config-core"

import type { AgentOverrideConfig } from "../config"

export type OmoOpenCodeConfigView = {
  readonly config: Record<string, unknown>
  readonly path: string
}

export type OmoOpenCodeConfigChain = {
  readonly diagnostics: readonly { readonly message: string; readonly path: string }[]
  readonly protectedUserView: Record<string, unknown>
  readonly views: readonly OmoOpenCodeConfigView[]
}

const NON_PLUGIN_FIELDS = new Set(["agents", "categories", "legacy_migrations", "models", "task", "teams"])

function block(config: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const value = config["[opencode]"]
  return isPlainRecord(value) ? value : {}
}

function profile(config: Readonly<Record<string, unknown>>, name: string | undefined): Record<string, unknown> {
  if (name === undefined) return {}
  const profiles = config.profiles
  if (!isPlainRecord(profiles)) return {}
  const selected = profiles[name]
  return isPlainRecord(selected) ? selected : {}
}

function baseView(config: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(config)) {
    if (key === "profiles" || (key.startsWith("[") && key.endsWith("]")) || NON_PLUGIN_FIELDS.has(key)) continue
    result[key] = value
  }
  return result
}

function recordFields(value: unknown, fields: readonly string[]): Record<string, unknown> | undefined {
  if (!isPlainRecord(value)) return undefined
  const result: Record<string, unknown> = {}
  for (const field of fields) {
    if (field in value) result[field] = value[field]
  }
  return Object.keys(result).length > 0 ? result : undefined
}

function modelInput(view: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const agents = isPlainRecord(view.agents)
    ? Object.fromEntries(Object.entries(view.agents).flatMap(([name, definition]) => {
      const fields = recordFields(definition, ["description", "prompt", "model", "models", "reasoning", "variant", "reasoningEffort", "tools", "temperature", "disable"])
      return fields === undefined ? [] : [[name, fields]]
    }))
    : undefined
  const categories = isPlainRecord(view.categories)
    ? Object.fromEntries(Object.entries(view.categories).flatMap(([name, definition]) => {
      const fields = recordFields(definition, ["description", "model", "models", "reasoning", "temperature", "top_p", "max_tokens", "provider_options", "fallback_models", "variant", "maxTokens", "thinking", "reasoningEffort", "textVerbosity", "tools", "prompt_append", "max_prompt_tokens", "is_unstable_agent", "disable", "warn_unavailable"])
      return fields === undefined ? [] : [[name, fields]]
    }))
    : undefined

  return {
    ...(isPlainRecord(view.models) ? { models: view.models } : {}),
    ...(agents === undefined ? {} : { agents }),
    ...(categories === undefined ? {} : { categories }),
  }
}

type AdaptedFallbackModel = string | Readonly<{
  model: string; reasoning?: OmoReasoning; temperature?: number; top_p?: number; maxTokens?: number
}>

function adaptPrimaryModel(entry: OmoAgentModelEntry): Partial<AgentOverrideConfig> {
  if (typeof entry === "string") return { model: entry }
  return {
    model: entry.model,
    ...(entry.reasoning === undefined ? {} : { reasoning: entry.reasoning }),
    ...(entry.temperature === undefined ? {} : { temperature: entry.temperature }),
    ...(entry.top_p === undefined ? {} : { top_p: entry.top_p }),
    ...(entry.max_tokens === undefined ? {} : { maxTokens: entry.max_tokens }),
    ...(entry.provider_options === undefined ? {} : { providerOptions: entry.provider_options }),
  }
}

function adaptFallbackModel(entry: OmoAgentModelEntry): AdaptedFallbackModel {
  if (typeof entry === "string") return entry
  return {
    model: entry.model,
    ...(entry.reasoning === undefined ? {} : { reasoning: entry.reasoning }),
    ...(entry.temperature === undefined ? {} : { temperature: entry.temperature }),
    ...(entry.top_p === undefined ? {} : { top_p: entry.top_p }),
    ...(entry.max_tokens === undefined ? {} : { maxTokens: entry.max_tokens }),
  }
}

function adaptAgentDefinition(definition: OmoAgentDef): AgentOverrideConfig {
  const base: AgentOverrideConfig = {
    ...(definition.description === undefined ? {} : { description: definition.description }),
    ...(definition.prompt === undefined ? {} : { prompt: definition.prompt }),
    ...(definition.model === undefined ? {} : { model: definition.model }),
    ...(definition.reasoning === undefined ? {} : { reasoning: definition.reasoning }),
    ...(definition.tools === undefined ? {} : { tools: definition.tools }),
    ...(definition.temperature === undefined ? {} : { temperature: definition.temperature }),
    ...(definition.disable === undefined ? {} : { disable: definition.disable }),
  }
  const primary = definition.models?.[0]
  if (primary === undefined) return base
  const fallbacks = definition.models?.slice(1).map(adaptFallbackModel) ?? []

  return {
    ...base,
    ...adaptPrimaryModel(primary),
    ...(fallbacks.length === 0 ? {} : { fallback_models: fallbacks }),
  }
}

function modelView(view: Readonly<Record<string, unknown>>): {
  readonly config: Record<string, unknown>
  readonly diagnostics: readonly { readonly message: string; readonly path: string }[]
} {
  const parsed = OmoConfigSchema.safeParse(modelInput(view))
  if (!parsed.success) return { config: {}, diagnostics: [] }

  const resolved = resolveModelReferences(parsed.data)
  const agents = resolved.view.agents === undefined
    ? undefined
    : Object.fromEntries(Object.entries(resolved.view.agents).map(([name, definition]) => [
      name,
      adaptAgentDefinition(definition),
    ]))
  return {
    config: {
      ...(agents === undefined ? {} : { agents }),
      ...(resolved.view.categories === undefined ? {} : { categories: resolved.view.categories }),
    },
    diagnostics: resolved.diagnostics,
  }
}

function modelViewWithCatalog(
  view: Readonly<Record<string, unknown>>,
  catalog: unknown,
): ReturnType<typeof modelView> {
  return modelView({
    ...view,
    ...(isPlainRecord(catalog) ? { models: catalog } : {}),
  })
}

function appendModelView(views: OmoOpenCodeConfigView[], resolvedView: ReturnType<typeof modelView>, path: string): void {
  if (Object.keys(resolvedView.config).length > 0) views.push({ config: resolvedView.config, path })
}

function appendConfigView(views: OmoOpenCodeConfigView[], config: Record<string, unknown>, path: string): void {
  if (Object.keys(config).length > 0) views.push({ config, path })
}

export function loadOmoOpenCodeConfigChain(
  directory: string,
  environment: OmoConfigEnv = process.env,
): OmoOpenCodeConfigChain {
  const loaded = loadOmoConfig({ cwd: directory, env: environment })
  const merged = loaded.layers.reduce<Record<string, unknown>>(
    (config, layer) => mergeOmoConfigRecords(config, layer.config),
    {},
  )
  const resolved = resolveOmoConfigView({
    config: merged,
    harness: "opencode",
    ...(loaded.profile === undefined ? {} : { profile: loaded.profile }),
  })
  const views: OmoOpenCodeConfigView[] = []
  const selectedProfile = loaded.profile
  const catalog = resolved.config.models

  for (const layer of loaded.layers) {
    const path = layer.source.path
    const harnessView = block(layer.config)
    const profileView = profile(layer.config, selectedProfile)
    const profileHarnessView = block(profileView)

    appendConfigView(views, baseView(layer.config), path)
    appendModelView(views, modelViewWithCatalog(layer.config, catalog), path)
    appendConfigView(views, harnessView, path)
    appendModelView(views, modelViewWithCatalog(harnessView, catalog), path)
    appendConfigView(views, baseView(profileView), path)
    appendModelView(views, modelViewWithCatalog(profileView, catalog), path)
    appendConfigView(views, profileHarnessView, path)
    appendModelView(views, modelViewWithCatalog(profileHarnessView, catalog), path)
  }

  const resolvedModels = modelViewWithCatalog(resolved.config, catalog)

  let protectedUserView: Record<string, unknown> = {}
  for (const layer of loaded.layers) {
    if (layer.source.scope !== "user") continue
    protectedUserView = mergeOmoConfigRecords(protectedUserView, block(layer.config))
  }
  for (const layer of loaded.layers) {
    if (layer.source.scope !== "user") continue
    protectedUserView = mergeOmoConfigRecords(protectedUserView, block(profile(layer.config, selectedProfile)))
  }

  return {
    diagnostics: [
      ...loaded.diagnostics,
      ...resolvedModels.diagnostics,
    ],
    protectedUserView,
    views,
  }
}
