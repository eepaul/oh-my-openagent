#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import { rmSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { createBoulderWaitingScenario, findOnPath, readBoulderReceipt, selfTestLocalExtension } from "./probe-boulder-waiting-local-extension.mjs"
import { digestDirectory } from "./drive.mjs"

const scriptDir = dirname(fileURLToPath(import.meta.url))
const mockProviderEntry = join(scriptDir, "mock-provider", "index.ts")
const localExtensionEntry = join(scriptDir, "probe-boulder-waiting-local-extension.mjs")
const realSenpiAgentDir = join(homedir(), ".senpi", "agent")
const CONTINUATION_TAG = "<omo-senpi-start-work-continuation>"

function runLocalExtensionDriver(status) {
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

function runScenario(senpiBin, status) {
  const scenario = createBoulderWaitingScenario(status)
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
    const receipt = readBoulderReceipt(scenario.receiptPath, status)
    return {
      exitCode: run.status,
      seededFromLiveSession: receipt,
      continuationObserved: transcript.includes(CONTINUATION_TAG),
    }
  } finally {
    rmSync(scenario.sandbox.root, { recursive: true, force: true })
  }
}

function print({ result, reason, runtimeMode, liveAssertions, beforeDigest }) {
  const afterDigest = digestDirectory(realSenpiAgentDir)
  console.log(
    JSON.stringify({
      result,
      ...(reason ? { reason } : {}),
      ...(runtimeMode ? { runtime_mode: runtimeMode } : {}),
      ...(liveAssertions ? { live_assertions: liveAssertions } : {}),
      realSenpiUntouched: beforeDigest === afterDigest,
    }),
  )
}

async function main() {
  const beforeDigest = digestDirectory(realSenpiAgentDir)
  const senpiBin = process.env.SENPI_BIN?.trim() || "senpi"
  const resolvedSenpi = findOnPath(senpiBin)
  let runtimeMode = "senpi-cli"
  let waiting
  let active

  try {
    if (resolvedSenpi === null) {
      runtimeMode = "in-process-local-extension"
      waiting = runLocalExtensionDriver("waiting_on_human")
      active = runLocalExtensionDriver("active")
    } else {
      waiting = runScenario(resolvedSenpi, "waiting_on_human")
      active = runScenario(resolvedSenpi, "active")
    }
  } catch {
    print({
      result: "FAIL",
      reason: "local-extension-load-or-drive-failed",
      runtimeMode,
      liveAssertions: { waiting_no_continuation: false, active_continuation: false },
      beforeDigest,
    })
    process.exitCode = 1
    return
  }

  const waitingOnHumanNoContinuation =
    (runtimeMode === "senpi-cli" ? waiting.exitCode === 0 && waiting.seededFromLiveSession : waiting.inputObserved) &&
    !waiting.continuationObserved
  const activeContinuation =
    (runtimeMode === "senpi-cli" ? active.exitCode === 0 && active.seededFromLiveSession : active.inputObserved) && active.continuationObserved
  const result = waitingOnHumanNoContinuation && activeContinuation ? "PASS" : "FAIL"
  print({
    result,
    runtimeMode,
    liveAssertions: {
      waiting_no_continuation: waitingOnHumanNoContinuation,
      active_continuation: activeContinuation,
    },
    beforeDigest,
  })
  if (result !== "PASS") process.exitCode = 1
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--self-test")) {
    selfTestLocalExtension()
    console.log("SELF-TEST OK")
  } else {
    main()
  }
}
