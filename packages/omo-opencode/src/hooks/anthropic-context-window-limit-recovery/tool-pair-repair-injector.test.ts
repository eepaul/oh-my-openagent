import { describe, expect, test } from "bun:test"
import { createToolPairRepairInjectorHook } from "./tool-pair-repair-injector"
import type { AutoCompactState, ToolPairRepairSyntheticMessage } from "./types"

const RECOVERY_CONTINUATION = "Recovered missing tool results. Continue from the repaired tool output."

type TestPart = { type: string; id?: string; toolUseId?: string }
type TestMessage = { info: { role: "assistant" | "user"; sessionID?: string }; parts: TestPart[] }

function createState(): AutoCompactState {
  return {
    pendingCompact: new Set<string>(),
    errorDataBySession: new Map(),
    retryStateBySession: new Map(),
    retryTimerBySession: new Map(),
    truncateStateBySession: new Map(),
    emptyContentAttemptBySession: new Map(),
    toolPairRepairBySession: new Map<string, Set<string>>(),
    toolPairRepairMessagesBySession: new Map<string, ToolPairRepairSyntheticMessage[]>(),
    compactionInProgress: new Set<string>(),
  }
}

function createSynthetic(sessionID: string, toolUseID: string): ToolPairRepairSyntheticMessage {
  return {
    info: { role: "user", sessionID },
    parts: [
      {
        type: "tool_result",
        toolUseId: toolUseID,
        tool_use_id: toolUseID,
        isError: false,
        content: [{ type: "text", text: "recovered output" }],
      },
      { type: "text", text: RECOVERY_CONTINUATION, synthetic: true },
    ],
  }
}

async function runInjector(
  state: AutoCompactState,
  messages: TestMessage[],
): Promise<void> {
  const hook = createToolPairRepairInjectorHook(() => state)
  const transform = hook["experimental.chat.messages.transform"]
  if (!transform) {
    throw new Error("missing tool pair repair injector transform")
  }
  await transform({}, { messages: messages as never })
}

describe("createToolPairRepairInjectorHook", () => {
  test("#given pending synthetic message #when transform runs #then inserts it after the assistant and clears the entry", async () => {
    //#given
    const state = createState()
    const sessionID = "session-insert"
    const synthetic = createSynthetic(sessionID, "toolu_a")
    state.toolPairRepairMessagesBySession?.set(sessionID, [synthetic])
    const messages: TestMessage[] = [
      { info: { role: "user", sessionID }, parts: [{ type: "text" } as TestPart] },
      { info: { role: "assistant", sessionID }, parts: [{ type: "tool_use", id: "toolu_a" }] },
    ]

    //#when
    await runInjector(state, messages)

    //#then
    expect(messages).toHaveLength(3)
    expect(messages[2]).toEqual(synthetic as never)
    expect(state.toolPairRepairMessagesBySession?.get(sessionID)).toBeUndefined()
  })

  test("#given no pending synthetic message #when transform runs #then leaves messages unchanged", async () => {
    //#given
    const state = createState()
    const messages: TestMessage[] = [
      { info: { role: "user", sessionID: "session-empty" }, parts: [{ type: "text" } as TestPart] },
      { info: { role: "assistant", sessionID: "session-empty" }, parts: [{ type: "tool_use", id: "toolu_z" }] },
    ]
    const snapshot = JSON.parse(JSON.stringify(messages))

    //#when
    await runInjector(state, messages)

    //#then
    expect(messages).toHaveLength(2)
    expect(messages).toEqual(snapshot)
  })

  test("#given an assistant in the middle #when transform runs #then splices synthetic immediately after it", async () => {
    //#given
    const state = createState()
    const sessionID = "session-mid"
    const synthetic = createSynthetic(sessionID, "toolu_mid")
    state.toolPairRepairMessagesBySession?.set(sessionID, [synthetic])
    const trailing: TestMessage = { info: { role: "user", sessionID }, parts: [{ type: "text" } as TestPart] }
    const messages: TestMessage[] = [
      { info: { role: "user", sessionID }, parts: [{ type: "text" } as TestPart] },
      { info: { role: "assistant", sessionID }, parts: [{ type: "tool_use", id: "toolu_mid" }] },
      trailing,
    ]

    //#when
    await runInjector(state, messages)

    //#then
    expect(messages).toHaveLength(4)
    expect(messages[2]).toEqual(synthetic as never)
    expect(messages[3]).toBe(trailing)
  })
})
