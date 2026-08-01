/// <reference types="bun-types" />
import { afterEach, describe, expect, test } from "bun:test"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"
import { fetchSyncResult } from "./sync-result-fetcher"
import { pollSyncSession } from "./sync-session-poller"
import { __resetTimingConfig, __setTimingConfig } from "./timing"
import type { OpencodeClient, ToolContextWithMetadata } from "./types"

const toolContext: ToolContextWithMetadata = {
  sessionID: "ses_parent",
  messageID: "msg_parent",
  agent: "sisyphus",
  abort: new AbortController().signal,
}

describe("pollSyncSession status fallback", () => {
  afterEach(() => {
    __resetTimingConfig()
  })

  test("#given status API is unavailable but assistant text exists #when polling #then messages complete the sync task", async () => {
    // given
    __setTimingConfig({
      POLL_INTERVAL_MS: 1,
      MAX_POLL_TIME_MS: 50,
    })
    const client = unsafeTestValue<OpencodeClient>({
      session: {
        messages: async () => ({
          data: [
            {
              info: { role: "assistant" },
              parts: [{ type: "text", text: "done" }],
            },
          ],
        }),
        abort: async () => ({ data: {} }),
      },
    })

    // when
    const result = await pollSyncSession(toolContext, client, {
      sessionID: "ses_missing_status",
      agentToUse: "sisyphus",
      toastManager: null,
      taskId: undefined,
    }, 50)

    // then
    expect(result).toBeNull()
  })

  test("#given a completed session history and an unfinished continuation #when status is unavailable #then polling waits for the new terminal assistant turn", async () => {
    // given
    __setTimingConfig({
      POLL_INTERVAL_MS: 1,
      MAX_POLL_TIME_MS: 50,
    })
    const history = [
      { info: { id: "msg_001", role: "user" }, parts: [{ type: "text", text: "original request" }] },
      {
        info: { id: "msg_002", role: "assistant", finish: "stop" },
        parts: [{ type: "text", text: "old result" }],
      },
      { info: { id: "msg_003", role: "user" }, parts: [{ type: "text", text: "continue" }] },
    ]
    let messageCalls = 0
    const client = unsafeTestValue<OpencodeClient>({
      session: {
        messages: async () => {
          messageCalls++
          return {
            data: [
              ...history,
              {
                info: {
                  id: "msg_004",
                  role: "assistant",
                  ...(messageCalls > 1 ? { finish: "stop" } : {}),
                },
                parts: [{ type: "text", text: messageCalls > 1 ? "new result" : "new result in progress" }],
              },
            ],
          }
        },
        abort: async () => ({ data: {} }),
      },
    })

    // when
    const pollResult = await pollSyncSession(toolContext, client, {
      sessionID: "ses_continuation",
      agentToUse: "sisyphus",
      toastManager: null,
      taskId: undefined,
      anchorMessageCount: 2,
    }, 50)

    // then
    expect(pollResult).toBeNull()
    expect(messageCalls).toBe(2)
    const result = await fetchSyncResult(client, "ses_continuation", 2)
    expect(result).toEqual({ ok: true, textContent: "new result" })
  })
})
