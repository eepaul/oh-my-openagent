import { expect, spyOn } from "bun:test"
import * as fs from "node:fs"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

import { unsafeTestValue } from "../../../../test-support/unsafe-test-value"
import type { OhMyOpenCodeConfig } from "../config"
import {
  createBoulderState,
  readBoulderState,
  writeBoulderState,
} from "../features/boulder-state"
import { createChatMessageHandler } from "./chat-message"
import { createCommandExecuteBeforeHandler } from "./command-execute-before"
import { createToolExecuteBeforeHandler } from "./tool-execute-before"
import type { PluginContext } from "./types"

export const STOP_ENTRYPOINTS = ["native-command", "chat-message", "skill-tool"] as const
export const ARCHIVE_SCENARIOS = ["archived", "missing", "failed"] as const

export type StopEntrypoint = (typeof STOP_ENTRYPOINTS)[number]
export type ArchiveScenario = (typeof ARCHIVE_SCENARIOS)[number]
export type ArchiveFixture =
  | { readonly scenario: "archived"; readonly sourcePath: string; readonly originalBytes: Buffer }
  | { readonly scenario: "missing"; readonly sourcePath: string }
  | { readonly scenario: "failed"; readonly sourcePath: string; readonly originalBytes: Buffer }

export function prepareArchiveScenario(args: {
  readonly directory: string
  readonly scenario: ArchiveScenario
}): ArchiveFixture {
  const sourcePath = join(args.directory, ".omo", "boulder.json")
  if (args.scenario === "missing") return { scenario: args.scenario, sourcePath }

  writeBoulderState(
    args.directory,
    createBoulderState(join(args.directory, "plan.md"), "ses-stop", "atlas"),
  )
  const originalBytes = readFileSync(sourcePath)
  if (args.scenario === "failed") {
    spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("rename denied")
    })
  }
  return { scenario: args.scenario, sourcePath, originalBytes }
}

export async function runStopEntrypoint(args: {
  readonly directory: string
  readonly entrypoint: StopEntrypoint
  readonly hooks: Record<string, unknown>
}): Promise<string> {
  switch (args.entrypoint) {
    case "native-command": {
      const output = { parts: [] as Array<{ type: string; text?: string; synthetic?: boolean }> }
      const handler = createCommandExecuteBeforeHandler(unsafeTestValue({ hooks: args.hooks, directory: args.directory }))
      await handler({ command: "stop-continuation", sessionID: "ses-stop", arguments: "" }, output)
      return getSyntheticNotice(output.parts)
    }
    case "chat-message": {
      const output = { message: {}, parts: [{ type: "text", text: "/stop-continuation" }] }
      const handler = createChatMessageHandler({
        ctx: unsafeTestValue<PluginContext>({ directory: args.directory, client: { tui: { showToast: async () => {} } } }),
        pluginConfig: unsafeTestValue<OhMyOpenCodeConfig>({}),
        firstMessageVariantGate: { shouldOverride: () => false, markApplied: () => {} },
        hooks: unsafeTestValue(args.hooks),
      })
      await handler({ sessionID: "ses-stop", agent: "atlas" }, output)
      return getSyntheticNotice(output.parts)
    }
    case "skill-tool": {
      const output = { args: { name: "stop-continuation", user_message: "preserve this argument" } }
      const handler = createToolExecuteBeforeHandler({
        ctx: unsafeTestValue<PluginContext>({ directory: args.directory, client: {} }),
        hooks: unsafeTestValue(args.hooks),
      })
      await handler({ tool: "skill", sessionID: "ses-stop", callID: "call-stop" }, output)
      expect(output.args.user_message).toContain("preserve this argument")
      return output.args.user_message
    }
    default: {
      const unreachable: never = args.entrypoint
      return unreachable
    }
  }
}

export function expectArchiveOutcome(args: {
  readonly directory: string
  readonly fixture: ArchiveFixture
  readonly notice: string
}): void {
  switch (args.fixture.scenario) {
    case "archived": {
      const archivedPath = getArchivedPath(args.directory)
      expect(readBoulderState(args.directory)).toBeNull()
      expect(Buffer.compare(
        Uint8Array.from(readFileSync(archivedPath)),
        Uint8Array.from(args.fixture.originalBytes),
      )).toBe(0)
      expect(args.notice).toContain(archivedPath)
      expect(args.notice).toContain("/start-work")
      return
    }
    case "missing":
      expect(args.notice).toContain("nothing was archived")
      expect(args.notice).not.toContain("archived to")
      return
    case "failed":
      expect(args.notice).toContain("Boulder state archive FAILED")
      expect(args.notice).toContain("NOT removed")
      expect(args.notice).not.toContain("archived to")
      expect(existsSync(args.fixture.sourcePath)).toBeTrue()
      expect(readFileSync(args.fixture.sourcePath)).toEqual(args.fixture.originalBytes)
      return
    default: {
      const unreachable: never = args.fixture
      return unreachable
    }
  }
}

function getArchivedPath(directory: string): string {
  const name = readdirSync(join(directory, ".omo")).find((file) => file.startsWith("boulder.json.stopped-"))
  if (name === undefined) throw new Error("expected boulder archive")
  return join(directory, ".omo", name)
}

function getSyntheticNotice(parts: ReadonlyArray<{ readonly type: string; readonly text?: string; readonly synthetic?: boolean }>): string {
  const notice = parts.find((part) => part.synthetic === true)
  if (typeof notice?.text !== "string") throw new Error("expected boulder archive notice")
  return notice.text
}
