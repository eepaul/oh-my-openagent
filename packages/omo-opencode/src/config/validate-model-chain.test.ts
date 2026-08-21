/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { validatePluginConfig } from "./validate"

const OPENAI_ONLY_CONFIG = join(import.meta.dir, "../../../../oh-my-openagent-openai-only.optimized.jsonc")

function validateJsonc(
  name: string,
  projectContents: string,
  userContents?: string,
): ReturnType<typeof validatePluginConfig> {
  const root = mkdtempSync(join(tmpdir(), `omo-config-model-chain-${name}-`))
  const project = join(root, "project")
  const configDirectory = join(project, ".omo")

  try {
    mkdirSync(configDirectory, { recursive: true })
    writeFileSync(join(configDirectory, "omo.jsonc"), projectContents, "utf-8")
    if (userContents !== undefined) {
      const userConfigDirectory = join(root, ".omo")
      mkdirSync(userConfigDirectory, { recursive: true })
      writeFileSync(join(userConfigDirectory, "omo.jsonc"), userContents, "utf-8")
    }
    return validatePluginConfig(project, { HOME: root })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe("validatePluginConfig canonical agent model chains", () => {
  it("#given the root OpenAI-only config #when validating #then adapts all twelve agents", () => {
    const result = validateJsonc("openai-only", readFileSync(OPENAI_ONLY_CONFIG, "utf-8"))

    expect(result.valid).toBe(true)
    expect(result.messages).toEqual([])
    expect(result.config.agents).toEqual({
      sisyphus: { model: "openai/gpt-5.6-sol", reasoning: "medium" },
      hephaestus: { model: "openai/gpt-5.6-sol", reasoning: "medium" },
      oracle: { model: "openai/gpt-5.6-sol", reasoning: "xhigh" },
      librarian: {
        model: "openai/gpt-5.6-luna-fast",
        fallback_models: [{ model: "openai/gpt-5.4-nano" }],
      },
      explore: {
        model: "openai/gpt-5.6-luna-fast",
        fallback_models: [{ model: "openai/gpt-5.4-nano" }],
      },
      "multimodal-looker": {
        model: "openai/gpt-5.6-sol",
        reasoning: "low",
        fallback_models: [{ model: "openai/gpt-5-nano" }],
      },
      prometheus: { model: "openai/gpt-5.6-sol", reasoning: "high" },
      metis: { model: "openai/gpt-5.6-sol", reasoning: "high" },
      momus: {
        model: "openai/gpt-5.6-terra",
        reasoning: "high",
        fallback_models: [{ model: "openai/gpt-5.6-sol", reasoning: "xhigh" }],
      },
      atlas: { model: "openai/gpt-5.6-sol", reasoning: "medium" },
      "sisyphus-junior": { model: "openai/gpt-5.6-sol", reasoning: "medium" },
      "review-gpt-agent": { model: "openai/gpt-5.6-sol", reasoning: "xhigh" },
    })
  })

  it("#given a mixed canonical chain and opencode overlay #when validating #then preserves chain order tuning and overlay fields", () => {
    const result = validateJsonc("mixed-chain", JSON.stringify({
      agents: {
        sisyphus: {
          models: [
            {
              model: "provider/primary",
              reasoning: "medium",
              temperature: 0.1,
              top_p: 0.9,
              max_tokens: 4096,
              provider_options: { cache: true },
            },
            "provider/fallback-string",
            {
              model: "provider/fallback-object",
              reasoning: "high",
              temperature: 0.2,
              top_p: 0.8,
              max_tokens: 2048,
            },
          ],
        },
      },
      categories: {
        deep: { models: [{ model: "provider/category", reasoning: "low" }] },
      },
      "[opencode]": {
        agents: { sisyphus: { prompt: "overlay prompt" } },
        categories: { deep: { prompt_append: "overlay appendix" } },
      },
    }))

    expect(result.valid).toBe(true)
    expect(result.config.agents?.sisyphus).toEqual({
      model: "provider/primary",
      reasoning: "medium",
      temperature: 0.1,
      top_p: 0.9,
      maxTokens: 4096,
      providerOptions: { cache: true },
      prompt: "overlay prompt",
      fallback_models: [
        "provider/fallback-string",
        {
          model: "provider/fallback-object",
          reasoning: "high",
          temperature: 0.2,
          top_p: 0.8,
          maxTokens: 2048,
        },
      ],
    })
    expect(result.config.categories?.deep).toEqual({
      models: [{ model: "provider/category", reasoning: "low" }],
      prompt_append: "overlay appendix",
    })
  })

  it("#given root models and explicit opencode model fields #when validating #then the opencode overlay wins", () => {
    const result = validateJsonc("opencode-precedence", JSON.stringify({
      agents: {
        sisyphus: {
          description: "root description",
          models: [
            { model: "root/primary", reasoning: "low" },
            { model: "root/fallback", reasoning: "medium" },
          ],
        },
      },
      "[opencode]": {
        agents: {
          sisyphus: {
            model: "overlay/primary",
            reasoning: "xhigh",
            fallback_models: [
              "overlay/fallback-string",
              { model: "overlay/fallback-object", reasoning: "high" },
            ],
            prompt: "overlay prompt",
          },
        },
      },
    }))

    expect(result.valid).toBe(true)
    expect(result.config.agents?.sisyphus).toEqual({
      description: "root description",
      model: "overlay/primary",
      reasoning: "xhigh",
      fallback_models: [
        "overlay/fallback-string",
        { model: "overlay/fallback-object", reasoning: "high" },
      ],
      prompt: "overlay prompt",
    })
  })

  it("#given a user overlay model and project root models #when validating #then the later physical project layer wins", () => {
    const result = validateJsonc(
      "physical-layer-precedence",
      JSON.stringify({
        agents: {
          sisyphus: {
            models: [
              { model: "project/primary", reasoning: "high" },
              { model: "project/fallback", reasoning: "medium" },
            ],
          },
        },
      }),
      JSON.stringify({
        "[opencode]": {
          agents: {
            sisyphus: {
              model: "user/primary",
              reasoning: "low",
              fallback_models: [{ model: "user/fallback", reasoning: "minimal" }],
              prompt: "user prompt",
            },
          },
        },
      }),
    )

    expect(result.valid).toBe(true)
    expect(result.config.agents?.sisyphus).toEqual({
      model: "project/primary",
      reasoning: "high",
      fallback_models: [{ model: "project/fallback", reasoning: "medium" }],
      prompt: "user prompt",
    })
  })
})
