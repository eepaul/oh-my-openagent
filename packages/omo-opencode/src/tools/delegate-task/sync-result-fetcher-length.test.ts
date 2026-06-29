/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test"
import { fetchSyncResult } from "./sync-result-fetcher"

describe("fetchSyncResult length-stop handling", () => {
  test("latest assistant hit output length: returns incomplete error instead of reasoning", async () => {
    //#given - the provider stopped after filling the output budget with reasoning only
    const mockClient = {
      session: {
        messages: async () => ({
          data: [
            { info: { id: "msg_001", role: "user", time: { created: 1000 } } },
            {
              info: { id: "msg_002", role: "assistant", time: { created: 2000 } },
              parts: [{ type: "text", text: "Older completed work" }],
            },
            { info: { id: "msg_003", role: "user", time: { created: 3000 } } },
            {
              info: { id: "msg_004", role: "assistant", time: { created: 4000 }, finish: "length" },
              parts: [{ type: "reasoning", text: "I am still planning the edit..." }],
            },
          ],
        }),
      },
    }

    //#when
    const result = await fetchSyncResult(mockClient, "ses_length_stop", 2)

    //#then - a length stop is incomplete, not a successful sync subagent result
    expect(result.ok).toBe(false)
    if (result.ok) {
      throw new Error("expected length-stopped result to be rejected")
    }
    expect(result.error).toContain("output limit")
    expect(result.error).toContain("ses_length_stop")
  })
})
