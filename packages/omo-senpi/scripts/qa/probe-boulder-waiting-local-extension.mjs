#!/usr/bin/env bun
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { createSandbox, seedSandbox } from "./drive.mjs"

const scriptDir = dirname(fileURLToPath(import.meta.url))
const localExtensionEntry = resolve(scriptDir, "..", "..", "plugin", "extensions", "omo.js")
const CONTINUATION_TAG = "<omo-senpi-start-work-continuation>"

async function main(status) {
  if (status !== "waiting_on_human" && status !== "active") throw new Error(`unsupported probe status: ${status}`)
  if (!existsSync(localExtensionEntry)) throw new Error("built local extension is missing")

  const sandbox = createSandbox()
  const sessionId = `in-process-${status}`
  const host = createInProcessHost()
  const eventContext = {
    cwd: sandbox.cwd,
    sessionManager: { getSessionId: () => sessionId },
  }

  try {
    seedSandbox(sandbox)
    const extensionUrl = `${pathToFileURL(localExtensionEntry).href}?probe=${process.pid}-${status}`
    const { default: extension } = await import(extensionUrl)
    await extension(host.api)
    await host.dispatch("input", { type: "input", text: "run the boulder continuation probe", source: "interactive" }, eventContext)
    writeBoulderFixture(sandbox.cwd, status, sessionId)
    await host.dispatch("agent_end", { type: "agent_end" }, eventContext)
    await new Promise((resolve) => setTimeout(resolve, 250))
    const emittedDirectives = host.userMessages
      .map(({ content }) => content)
      .filter((content) => content.includes(CONTINUATION_TAG))
    console.log(
      JSON.stringify({
        inputObserved: host.dispatchedEvents.includes("input"),
        continuationObserved: emittedDirectives.length > 0,
        emittedDirectiveTags: emittedDirectives.map(() => CONTINUATION_TAG),
      }),
    )
  } finally {
    rmSync(sandbox.root, { recursive: true, force: true })
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

main(process.argv[2]).catch((error) => {
  console.error(error)
  process.exitCode = 1
})
