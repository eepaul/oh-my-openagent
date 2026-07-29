import { mock } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { createBoulderState, writeBoulderState } from "../../features/boulder-state"
import type {
  WaitingOnHumanNotificationInput,
  WaitingOnHumanNotifier,
} from "../shared/waiting-on-human-notifier"
import type { SessionState } from "./types"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"

export const ATLAS_WAITING_SESSION_ID = "atlas-waiting-session"

export function writeAtlasBoulder(directory: string, planPath: string): void {
  writeBoulderState(directory, createBoulderState(planPath, ATLAS_WAITING_SESSION_ID, "atlas"))
}

export function createAtlasWaitingContext(directory: string): {
  readonly ctx: PluginInput
  readonly promptAsync: ReturnType<typeof mock>
} {
  const promptAsync = mock(async (_input: unknown) => ({ data: {} }))
  return {
    ctx: unsafeTestValue<PluginInput>({
      directory,
      client: {
        session: {
          messages: async () => ({ data: [] }),
          promptAsync,
        },
      },
    }),
    promptAsync,
  }
}

export function createAtlasSessionState(): SessionState {
  return { promptFailureCount: 0 }
}

export function createWaitingNotifierSpy(): {
  readonly notifier: WaitingOnHumanNotifier
  readonly notifications: WaitingOnHumanNotificationInput[]
  readonly resetCalls: () => number
} {
  const notifications: WaitingOnHumanNotificationInput[] = []
  let resets = 0
  return {
    notifier: {
      maybeNotify: async (input) => {
        notifications.push(input)
        return { status: "dispatched", response: undefined }
      },
      reset: () => {
        resets += 1
      },
    },
    notifications,
    resetCalls: () => resets,
  }
}
