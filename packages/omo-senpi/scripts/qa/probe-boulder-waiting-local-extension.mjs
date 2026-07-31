#!/usr/bin/env bun
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { delimiter, dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { createSandbox, seedSandbox } from "./drive.mjs"

const scriptDir = dirname(fileURLToPath(import.meta.url))
const localExtensionEntry = resolve(scriptDir, "..", "..", "plugin", "extensions", "omo.js")
const CONTINUATION_TAG = "<omo-senpi-start-work-continuation>"

export function createBoulderWaitingScenario(status) {
  if (status !== "waiting_on_human" && status !== "active") throw new Error(`unsupported probe status: ${status}`)

  const sandbox = createSandbox()
  const receiptPath = join(sandbox.root, "boulder-seed-receipt.json")
  seedSandbox(sandbox)
  mkdirSync(join(sandbox.root, "sessions"), { recursive: true })
  mkdirSync(join(sandbox.agentDir, "extensions"), { recursive: true })
  writeFileSync(join(sandbox.cwd, "mock-script.json"), JSON.stringify({ steps: [{ type: "text", text: "boulder probe turn complete" }] }))
  writeFileSync(join(sandbox.agentDir, "extensions", "boulder-state-seeder.js"), makeSeederSource(status, receiptPath))
  return { sandbox, sessionDir: join(sandbox.root, "sessions"), receiptPath }
}

export async function runLocalExtensionScenario(status) {
  if (!existsSync(localExtensionEntry)) throw new Error("built local extension is missing")

  const scenario = createBoulderWaitingScenario(status)
  const host = createInProcessHost()
  const eventContext = { cwd: scenario.sandbox.cwd, sessionManager: { getSessionId: () => `in-process-${status}` } }

  try {
    const extensionUrl = `${pathToFileURL(localExtensionEntry).href}?probe=${process.pid}-${status}`
    const { default: extension } = await import(extensionUrl)
    await extension(host.api)
    await host.dispatch("input", { type: "input", text: "run the boulder continuation probe", source: "interactive" }, eventContext)
    writeBoulderFixture(scenario.sandbox.cwd, status, `in-process-${status}`)
    await host.dispatch("agent_end", { type: "agent_end" }, eventContext)
    await new Promise((resolve) => setTimeout(resolve, 250))
    const emittedDirectives = host.userMessages.map(({ content }) => content).filter((content) => content.includes(CONTINUATION_TAG))
    return {
      inputObserved: host.dispatchedEvents.includes("input"),
      continuationObserved: emittedDirectives.length > 0,
      emittedDirectiveTags: emittedDirectives.map(() => CONTINUATION_TAG),
    }
  } finally {
    rmSync(scenario.sandbox.root, { recursive: true, force: true })
  }
}

export function runLocalExtensionDriver(status) {
  const bun = findOnPath(process.env.BUN_BIN?.trim() || "bun")
  if (bun === null) throw new Error("bun-runtime-unavailable")
  const run = spawnSync(bun, [localExtensionEntry, status], {
    cwd: scriptDir,
    encoding: "utf8",
    timeout: 60_000,
  })
  if (run.status !== 0) throw new Error(`${run.stderr}\n${run.stdout}`.trim())
  const output = run.stdout.trim().split("\n").filter((line) => line.length > 0).at(-1)
  if (output === undefined) throw new Error("local-extension-driver-produced-no-result")
  return JSON.parse(output)
}

export function readBoulderReceipt(path, expectedStatus) {
  if (!existsSync(path)) return false
  try {
    const value = JSON.parse(readFileSync(path, "utf8"))
    return value?.status === expectedStatus && typeof value.sessionId === "string" && value.sessionId.length > 0
  } catch {
    return false
  }
}

export function findOnPath(bin) {
  if (bin.includes("/")) return existsSync(bin) ? bin : null
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = resolve(directory || ".", bin)
    if (existsSync(candidate)) return candidate
  }
  return null
}

export function selfTestLocalExtension() {
  const scenario = createBoulderWaitingScenario("waiting_on_human")
  try {
    const seeder = readFileSync(join(scenario.sandbox.agentDir, "extensions", "boulder-state-seeder.js"), "utf8")
    if (!seeder.includes('const status = "waiting_on_human"')) throw new Error("waiting status was not seeded")
    if (!seeder.includes('session_ids: ["senpi:" + sessionId]')) throw new Error("live session id was not bound")
    if (!existsSync(localExtensionEntry)) throw new Error("built local extension is missing")
  } finally {
    rmSync(scenario.sandbox.root, { recursive: true, force: true })
  }
}

function createInProcessHost() {
  const handlers = new Map()
  const userMessages = []
  const dispatchedEvents = []
  const api = {
    on(event, handler) {
      const registered = handlers.get(event) ?? []
      registered.push(handler)
      handlers.set(event, registered)
    },
    registerFlag() {},
    getFlag(name) {
      return name.endsWith("-disabled") && name !== "omo-senpi-disabled" && name !== "omo-senpi-start-work-continuation-disabled"
    },
    registerTool() {},
    registerCommand() {},
    registerMessageRenderer() {},
    registerMcpServer() {},
    sendUserMessage(content, options) {
      userMessages.push({ content, options })
    },
    logger: { info() {}, warn() {}, error() {} },
    events: { on() {}, emit() {} },
  }

  return {
    api,
    dispatchedEvents,
    userMessages,
    async dispatch(event, payload, context) {
      dispatchedEvents.push(event)
      for (const handler of handlers.get(event) ?? []) await handler(payload, context)
    },
  }
}

function writeBoulderFixture(cwd, status, sessionId) {
  const omoDirectory = join(cwd, ".omo")
  mkdirSync(join(omoDirectory, "plans"), { recursive: true })
  writeFileSync(join(omoDirectory, "plans", "probe.md"), "## TODOs\n- [ ] 1. Continue the probe\n")
  writeFileSync(
    join(omoDirectory, "boulder.json"),
    JSON.stringify({
      schema_version: 2,
      active_work_id: "probe-work",
      works: {
        "probe-work": {
          work_id: "probe-work",
          active_plan: ".omo/plans/probe.md",
          plan_name: "probe",
          session_ids: [`senpi:${sessionId}`],
          status,
          started_at: "2026-07-31T00:00:00Z",
          updated_at: "2026-07-31T00:00:00Z",
        },
      },
    }),
  )
}

function makeSeederSource(status, receiptPath) {
  return `import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const status = ${JSON.stringify(status)}
const receiptPath = ${JSON.stringify(receiptPath)}

export default function registerBoulderStateSeeder(pi) {
  pi.on("input", (_payload, eventCtx) => {
    const cwd = eventCtx?.cwd
    const sessionId = eventCtx?.sessionManager?.getSessionId?.()
    if (typeof cwd !== "string" || typeof sessionId !== "string") {
      throw new Error("boulder waiting probe requires live cwd and session id")
    }

    const omoDirectory = join(cwd, ".omo")
    mkdirSync(join(omoDirectory, "plans"), { recursive: true })
    writeFileSync(join(omoDirectory, "plans", "probe.md"), "## TODOs\\n- [ ] 1. Continue the probe\\n")
    writeFileSync(
      join(omoDirectory, "boulder.json"),
      JSON.stringify({
        schema_version: 2,
        active_work_id: "probe-work",
        works: {
          "probe-work": {
            work_id: "probe-work",
            active_plan: ".omo/plans/probe.md",
            plan_name: "probe",
            session_ids: ["senpi:" + sessionId],
            status,
            started_at: "2026-07-31T00:00:00Z",
          },
        },
      }),
    )
    writeFileSync(receiptPath, JSON.stringify({ status, sessionId }))
  })
}
`
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--self-test")) {
    selfTestLocalExtension()
    console.log("SELF-TEST OK")
  } else {
    runLocalExtensionScenario(process.argv[2]).then((result) => console.log(JSON.stringify(result)))
  }
}
