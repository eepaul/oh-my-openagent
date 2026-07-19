const MODEL_SETTINGS_KEYS = [
  "model",
  "variant",
  "temperature",
  "top_p",
  "maxTokens",
  "thinking",
  "reasoningEffort",
  "textVerbosity",
  "providerOptions",
  "fallback_models",
] as const

function getExternalDirectoryPermission(permission: unknown): string | undefined {
  if (permission === null || typeof permission !== "object") {
    return undefined
  }

  const externalDirectory = (permission as Record<string, unknown>).external_directory
  return typeof externalDirectory === "string" ? externalDirectory : undefined
}

export function buildPlanDemoteConfig(
  prometheusConfig: Record<string, unknown> | undefined,
  planOverride: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const modelSettings: Record<string, unknown> = {}

  for (const key of MODEL_SETTINGS_KEYS) {
    const value = planOverride?.[key] ?? prometheusConfig?.[key]
    if (value !== undefined) {
      modelSettings[key] = value
    }
  }

  const externalDirectoryPermission =
    getExternalDirectoryPermission(planOverride?.permission) ??
    getExternalDirectoryPermission(prometheusConfig?.permission)

  if (externalDirectoryPermission !== undefined) {
    modelSettings.permission = { external_directory: externalDirectoryPermission }
  }

  return { mode: "subagent" as const, hidden: true, ...modelSettings }
}
