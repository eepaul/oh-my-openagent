#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { createSandbox, digestDirectory, seedSandbox } from "./drive.mjs"

const scriptDir = dirname(fileURLToPath(import.meta.url))
const mockProviderEntry = join(scriptDir, "mock-provider", "index.ts")
const realSenpiAgentDir = join(homedir(), ".senpi", "agent")
const CONTINUATION_TAG = "<omo-senpi-start-work-continuation>"

function createScenario(status) {
  const sandbox = createSandbox()
  const sessionDir = join(sandbox.root, "sessions")
  const receiptPath = join(sandbox.root, "boulder-seed-receipt.json")
  const extensionsDir = join(sandbox.agentDir, "extensions")
  seedSandbox(sandbox)
  mkdirSync(sessionDir, { recursive: true })
  mkdirSync(extensionsDir, { recursive: true })
  writeFileSync(join(sandbox.cwd, "mock-script.json"), JSON.stringify({ steps: [{ type: "text", text: "boulder probe turn complete" }] }))
  writeFileSync(join(extensionsDir, "boulder-state-seeder.js"), makeSeederSource(status, receiptPath))
  return { sandbox, sessionDir, receiptPath }
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

function runScenario(senpiBin, status) {
  const scenario = createScenario(status)
  try {
    const run = spawnSync(
      senpiBin,
      [
        "-e",
        mockProviderEntry,
        "-p",
        "--mode",
        "json",
        "--provider",
        "omo-mock",
        "--model",
        "mock-1",
        "--session-dir",
        scenario.sessionDir,
        "run the boulder continuation probe",
      ],
      {
        cwd: scenario.sandbox.cwd,
        env: {
          ...process.env,
          SENPI_CODING_AGENT_DIR: scenario.sandbox.agentDir,
          SENPI_CODING_AGENT_SESSION_DIR: scenario.sessionDir,
          OMO_SENPI_QA: "1",
        },
        encoding: "utf8",
        timeout: 60_000,
      },
    )
    const transcript = `${run.stdout}\n${run.stderr}`
    const receipt = readReceipt(scenario.receiptPath, status)
    return {
      exitCode: run.status,
      seededFromLiveSession: receipt,
      continuationObserved: transcript.includes(CONTINUATION_TAG),
    }
  } finally {
    rmSync(scenario.sandbox.root, { recursive: true, force: true })
  }
}

function readReceipt(path, expectedStatus) {
  if (!existsSync(path)) return false
  try {
    const value = JSON.parse(readFileSync(path, "utf8"))
    return value?.status === expectedStatus && typeof value.sessionId === "string" && value.sessionId.length > 0
  } catch {
    return false
  }
}

function findOnPath(bin) {
  if (bin.includes("/")) return existsSync(bin) ? bin : null
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = resolve(directory || ".", bin)
    if (existsSync(candidate)) return candidate
  }
  return null
}

function main() {
  const beforeDigest = digestDirectory(realSenpiAgentDir)
  const senpiBin = process.env.SENPI_BIN?.trim() || "senpi"
  const resolvedSenpi = findOnPath(senpiBin)
  if (resolvedSenpi === null) {
    print({
      result: "SKIP",
      reason: "senpi-binary-unavailable",
      waitingOnHumanNoContinuation: false,
      activeContinuation: false,
      beforeDigest,
    })
    return
  }

  const waiting = runScenario(resolvedSenpi, "waiting_on_human")
  const active = runScenario(resolvedSenpi, "active")
  const waitingOnHumanNoContinuation =
    waiting.exitCode === 0 && waiting.seededFromLiveSession && !waiting.continuationObserved
  const activeContinuation = active.exitCode === 0 && active.seededFromLiveSession && active.continuationObserved
  print({
    result: waitingOnHumanNoContinuation && activeContinuation ? "PASS" : "FAIL",
    waitingOnHumanNoContinuation,
    activeContinuation,
    beforeDigest,
  })
}

function print({ result, reason, waitingOnHumanNoContinuation, activeContinuation, beforeDigest }) {
  const afterDigest = digestDirectory(realSenpiAgentDir)
  console.log(
    JSON.stringify({
      result,
      ...(reason ? { reason } : {}),
      waitingOnHumanNoContinuation,
      activeContinuation,
      realSenpiUntouched: beforeDigest === afterDigest,
    }),
  )
}

function selfTest() {
  const scenario = createScenario("waiting_on_human")
  try {
    const seeder = readFileSync(join(scenario.sandbox.agentDir, "extensions", "boulder-state-seeder.js"), "utf8")
    if (!seeder.includes('const status = "waiting_on_human"')) throw new Error("waiting status was not seeded")
    if (!seeder.includes('session_ids: ["senpi:" + sessionId]')) throw new Error("live session id was not bound")
  } finally {
    rmSync(scenario.sandbox.root, { recursive: true, force: true })
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--self-test")) {
    selfTest()
    console.log("SELF-TEST OK")
  } else {
    main()
  }
}
