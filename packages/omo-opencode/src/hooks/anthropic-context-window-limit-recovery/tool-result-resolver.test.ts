import { afterAll, describe, expect, mock, test } from "bun:test"

mock.module("../../shared/logger", () => ({
  log: () => {},
}))

const resolverModulePromise = import("./tool-result-resolver")

afterAll(() => {
  mock.restore()
})

function makeClient(messagesImpl: () => Promise<unknown>) {
  return {
    session: {
      messages: mock(messagesImpl),
    },
  } as never
}

describe("resolveToolOutputs", () => {
  describe("#given a completed tool part with a matching callID", () => {
    test("#when resolving #then it returns the real state.output", async () => {
      // given
      const { resolveToolOutputs } = await resolverModulePromise
      const client = makeClient(() =>
        Promise.resolve({
          data: [
            {
              info: { id: "msg-1", role: "assistant" },
              parts: [
                {
                  type: "tool",
                  callID: "toolu_01BBdTSb8SVjxJNJNoJsed3g",
                  state: { status: "completed", output: "Edit applied successfully." },
                },
              ],
            },
          ],
        }),
      )

      // when
      const result = await resolveToolOutputs(client, "ses-1", "/proj", ["toolu_01BBdTSb8SVjxJNJNoJsed3g"])

      // then
      expect(result.get("toolu_01BBdTSb8SVjxJNJNoJsed3g")).toEqual({
        output: "Edit applied successfully.",
        status: "completed",
      })
    })

    test("#when several ids are requested #then each resolved id carries its own output", async () => {
      // given
      const { resolveToolOutputs } = await resolverModulePromise
      const client = makeClient(() =>
        Promise.resolve({
          data: [
            {
              info: { id: "msg-1", role: "assistant" },
              parts: [
                { type: "tool", callID: "toolu_A", state: { status: "completed", output: "out-a" } },
                { type: "text", text: "narration" },
                { type: "tool", callID: "toolu_B", state: { status: "completed", output: "out-b" } },
              ],
            },
          ],
        }),
      )

      // when
      const result = await resolveToolOutputs(client, "ses-1", "/proj", ["toolu_A", "toolu_B"])

      // then
      expect(result.get("toolu_A")).toEqual({ output: "out-a", status: "completed" })
      expect(result.get("toolu_B")).toEqual({ output: "out-b", status: "completed" })
    })
  })

  describe("#given tool parts that are not usable", () => {
    test("#when status is error #then the id maps to null", async () => {
      // given
      const { resolveToolOutputs } = await resolverModulePromise
      const client = makeClient(() =>
        Promise.resolve({
          data: [
            {
              info: { id: "msg-1", role: "assistant" },
              parts: [{ type: "tool", callID: "toolu_ERR", state: { status: "error", output: "boom" } }],
            },
          ],
        }),
      )

      // when
      const result = await resolveToolOutputs(client, "ses-1", "/proj", ["toolu_ERR"])

      // then
      expect(result.get("toolu_ERR")).toBeNull()
    })

    test("#when status is pending #then the id maps to null", async () => {
      // given
      const { resolveToolOutputs } = await resolverModulePromise
      const client = makeClient(() =>
        Promise.resolve({
          data: [
            {
              info: { id: "msg-1", role: "assistant" },
              parts: [{ type: "tool", callID: "toolu_PEND", state: { status: "pending" } }],
            },
          ],
        }),
      )

      // when
      const result = await resolveToolOutputs(client, "ses-1", "/proj", ["toolu_PEND"])

      // then
      expect(result.get("toolu_PEND")).toBeNull()
    })

    test("#when completed but output is missing #then the id maps to null", async () => {
      // given
      const { resolveToolOutputs } = await resolverModulePromise
      const client = makeClient(() =>
        Promise.resolve({
          data: [
            {
              info: { id: "msg-1", role: "assistant" },
              parts: [{ type: "tool", callID: "toolu_NOOUT", state: { status: "completed" } }],
            },
          ],
        }),
      )

      // when
      const result = await resolveToolOutputs(client, "ses-1", "/proj", ["toolu_NOOUT"])

      // then
      expect(result.get("toolu_NOOUT")).toBeNull()
    })
  })

  describe("#given edge-case inputs", () => {
    test("#when toolUseIDs is empty #then it returns an empty Map without calling the SDK", async () => {
      // given
      const { resolveToolOutputs } = await resolverModulePromise
      const messages = mock(() => Promise.resolve({ data: [] }))
      const client = { session: { messages } } as never

      // when
      const result = await resolveToolOutputs(client, "ses-1", "/proj", [])

      // then
      expect(result.size).toBe(0)
      expect(messages).not.toHaveBeenCalled()
    })

    test("#when the SDK response is abnormal (data not an array) #then it returns an empty Map", async () => {
      // given
      const { resolveToolOutputs } = await resolverModulePromise
      const client = makeClient(() => Promise.resolve({ data: null }))

      // when
      const result = await resolveToolOutputs(client, "ses-1", "/proj", ["toolu_X"])

      // then
      expect(result.size).toBe(0)
    })

    test("#when the SDK call throws #then it does not throw and returns an empty Map", async () => {
      // given
      const { resolveToolOutputs } = await resolverModulePromise
      const client = makeClient(() => Promise.reject(new Error("network down")))

      // when
      const result = await resolveToolOutputs(client, "ses-1", "/proj", ["toolu_X"])

      // then
      expect(result.size).toBe(0)
    })

    test("#when output is a non-string object #then it is JSON-stringified", async () => {
      // given
      const { resolveToolOutputs } = await resolverModulePromise
      const payload = { ok: true, n: 1 }
      const client = makeClient(() =>
        Promise.resolve({
          data: [
            {
              info: { id: "msg-1", role: "assistant" },
              parts: [{ type: "tool", callID: "toolu_OBJ", state: { status: "completed", output: payload } }],
            },
          ],
        }),
      )

      // when
      const result = await resolveToolOutputs(client, "ses-1", "/proj", ["toolu_OBJ"])

      // then
      expect(result.get("toolu_OBJ")).toEqual({ output: JSON.stringify(payload), status: "completed" })
    })

    test("#when output exceeds 20000 chars #then it is truncated to 20000 chars", async () => {
      // given
      const { resolveToolOutputs } = await resolverModulePromise
      const huge = "x".repeat(25000)
      const client = makeClient(() =>
        Promise.resolve({
          data: [
            {
              info: { id: "msg-1", role: "assistant" },
              parts: [{ type: "tool", callID: "toolu_BIG", state: { status: "completed", output: huge } }],
            },
          ],
        }),
      )

      // when
      const result = await resolveToolOutputs(client, "ses-1", "/proj", ["toolu_BIG"])

      // then
      expect(result.get("toolu_BIG")?.output.length).toBe(20000)
    })

    test("#when a requested id is absent from every message #then it is absent from the Map", async () => {
      // given
      const { resolveToolOutputs } = await resolverModulePromise
      const client = makeClient(() =>
        Promise.resolve({
          data: [
            {
              info: { id: "msg-1", role: "assistant" },
              parts: [{ type: "tool", callID: "toolu_OTHER", state: { status: "completed", output: "x" } }],
            },
          ],
        }),
      )

      // when
      const result = await resolveToolOutputs(client, "ses-1", "/proj", ["toolu_MISSING"])

      // then
      expect(result.has("toolu_MISSING")).toBe(false)
    })

    test("#when a part is malformed #then it is skipped without throwing", async () => {
      // given
      const { resolveToolOutputs } = await resolverModulePromise
      const client = makeClient(() =>
        Promise.resolve({
          data: [
            { info: { id: "msg-1", role: "assistant" }, parts: null },
            {
              info: { id: "msg-2", role: "assistant" },
              parts: [
                null,
                { type: "tool" },
                { type: "tool", callID: "toolu_OK", state: { status: "completed", output: "good" } },
              ],
            },
          ],
        }),
      )

      // when
      const result = await resolveToolOutputs(client, "ses-1", "/proj", ["toolu_OK"])

      // then
      expect(result.get("toolu_OK")).toEqual({ output: "good", status: "completed" })
    })
  })
})
