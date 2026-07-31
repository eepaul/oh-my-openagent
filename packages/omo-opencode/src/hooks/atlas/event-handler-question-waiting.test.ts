import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createBoulderState, getWorkById, writeBoulderState } from "../../features/boulder-state"
import { createAtlasEventHandler } from "./event-handler"
import type { SessionState } from "./types"
import { createWaitingNotifierSpy } from "./waiting-on-human-test-helpers.test"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"

describe("Atlas pending question part events", () => {
  let directory = ""
  let sessionID = ""
  let workID = ""

  beforeEach(() => {
    directory = join(tmpdir(), `atlas-question-event-${randomUUID()}`)
    mkdirSync(directory, { recursive: true })
    sessionID = `ses-${randomUUID()}`
    const planPath = join(directory, "plan.md")
    writeFileSync(planPath, "## TODOs\n- [ ] 1. Continue\n")
    const state = createBoulderState(planPath, sessionID, "atlas")
    workID = state.active_work_id ?? ""
    writeBoulderState(directory, state)
  })

  afterEach(() => {
    if (existsSync(directory)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("#given a bound session emits a running Question part without session.idle #when Atlas receives message.part.updated #then it persists question-tool waiting using the stable call ID", async () => {
    // given
    let continuationPrompts = 0
    const ctx = unsafeTestValue<PluginInput>({
      directory,
      client: {
        session: {
          messages: async () => ({
            data: [{
              info: { role: "assistant" },
              parts: [{
                type: "tool",
                id: "part-id-not-the-call-id",
                callID: "call-running-question",
                tool: "question",
                state: { status: "running" },
              }],
            }],
          }),
          promptAsync: async () => {
            continuationPrompts += 1
          },
        },
      },
    })
    const sessions = new Map<string, SessionState>()
    const getState = (id: string): SessionState => {
      const state = sessions.get(id) ?? { promptFailureCount: 0 }
      sessions.set(id, state)
      return state
    }
    const { notifier, notifications } = createWaitingNotifierSpy()
    const handler = createAtlasEventHandler({
      ctx,
      options: { directory, waitingOnHumanNotifier: notifier },
      sessions,
      getState,
    })

    // when
    await handler({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            id: "part-id-not-the-call-id",
            sessionID,
            type: "tool",
            tool: "question",
            callID: "call-running-question",
            state: { status: "running" },
          },
        },
      },
    })

    // then
    expect(getWorkById(directory, workID)?.status).toBe("waiting_on_human")
    expect(getWorkById(directory, workID)?.waiting?.source).toBe("question-tool")
    expect(getWorkById(directory, workID)?.waiting?.question_call_id).toBe("call-running-question")
    expect(continuationPrompts).toBe(0)
    expect(notifications).toHaveLength(1)
  })
})
