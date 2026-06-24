import { afterAll, describe, it, expect, mock, beforeEach } from "bun:test"
import { preserveModuleMocksForTestFile, restoreModuleMocksForTestFile } from "../../testing/module-mock-lifecycle"

mock.restore()

const mockReplaceEmptyTextParts = mock(() => Promise.resolve(false))
const mockInjectTextPart = mock(() => Promise.resolve(false))
const mockFindEmptyTextPartsFromSDK = mock(() => Promise.resolve([] as string[]))

mock.module("./storage/empty-text", () => ({
  replaceEmptyTextPartsAsync: mockReplaceEmptyTextParts,
  findMessagesWithEmptyTextPartsFromSDK: mockFindEmptyTextPartsFromSDK,
}))
mock.module("./storage/text-part-injector", () => ({
  injectTextPartAsync: mockInjectTextPart,
}))

preserveModuleMocksForTestFile(import.meta.url)

const emptyContentRecoveryModulePromise = import("./empty-content-recovery-sdk")

afterAll(() => {
  restoreModuleMocksForTestFile(import.meta.url)
  mock.restore()
})

function createMockClient(messages: Array<{ info?: { id?: string }; parts?: Array<{ type?: string; text?: string }> }>) {
  return {
    session: {
      messages: mock(() => Promise.resolve({ data: messages })),
    },
  } as never
}

describe("fixEmptyMessagesWithSDK", () => {
  beforeEach(() => {
    mockReplaceEmptyTextParts.mockReset()
    mockInjectTextPart.mockReset()
    mockFindEmptyTextPartsFromSDK.mockReset()
    mockReplaceEmptyTextParts.mockReturnValue(Promise.resolve(false))
    mockInjectTextPart.mockReturnValue(Promise.resolve(false))
    mockFindEmptyTextPartsFromSDK.mockReturnValue(Promise.resolve([]))
  })

  it("returns fixed=false when no empty messages exist", async () => {
    //#given
    const { fixEmptyMessagesWithSDK } = await emptyContentRecoveryModulePromise
    const client = createMockClient([
      { info: { id: "msg_1" }, parts: [{ type: "text", text: "Hello" }] },
    ])

    //#when
    const result = await fixEmptyMessagesWithSDK({
      sessionID: "ses_1",
      client,
      placeholderText: "[recovered]",
    })

    //#then
    expect(result.fixed).toBe(false)
    expect(result.fixedMessageIds).toEqual([])
    expect(result.scannedEmptyCount).toBe(0)
  })

  it("fixes empty message via replace when scanning all", async () => {
    //#given
    const { fixEmptyMessagesWithSDK } = await emptyContentRecoveryModulePromise
    const client = createMockClient([
      { info: { id: "msg_1" }, parts: [{ type: "text", text: "" }] },
    ])
    mockReplaceEmptyTextParts.mockReturnValue(Promise.resolve(true))

    //#when
    const result = await fixEmptyMessagesWithSDK({
      sessionID: "ses_1",
      client,
      placeholderText: "[recovered]",
    })

    //#then
    expect(result.fixed).toBe(true)
    expect(result.fixedMessageIds).toContain("msg_1")
    expect(result.scannedEmptyCount).toBe(1)
  })

  it("falls back to inject when replace fails", async () => {
    //#given
    const { fixEmptyMessagesWithSDK } = await emptyContentRecoveryModulePromise
    const client = createMockClient([
      { info: { id: "msg_1" }, parts: [] },
    ])
    mockReplaceEmptyTextParts.mockReturnValue(Promise.resolve(false))
    mockInjectTextPart.mockReturnValue(Promise.resolve(true))

    //#when
    const result = await fixEmptyMessagesWithSDK({
      sessionID: "ses_1",
      client,
      placeholderText: "[recovered]",
    })

    //#then
    expect(result.fixed).toBe(true)
    expect(result.fixedMessageIds).toContain("msg_1")
  })

  it("fixes target message by index when provided", async () => {
    //#given
    const { fixEmptyMessagesWithSDK } = await emptyContentRecoveryModulePromise
    const client = createMockClient([
      { info: { id: "msg_0" }, parts: [{ type: "text", text: "ok" }] },
      { info: { id: "msg_1" }, parts: [] },
    ])
    mockReplaceEmptyTextParts.mockReturnValue(Promise.resolve(true))

    //#when
    const result = await fixEmptyMessagesWithSDK({
      sessionID: "ses_1",
      client,
      placeholderText: "[recovered]",
      messageIndex: 1,
    })

    //#then
    expect(result.fixed).toBe(true)
    expect(result.fixedMessageIds).toContain("msg_1")
    expect(result.scannedEmptyCount).toBe(0)
  })

  it("skips messages without info.id", async () => {
    //#given
    const { fixEmptyMessagesWithSDK } = await emptyContentRecoveryModulePromise
    const client = createMockClient([
      { parts: [] },
      { info: {}, parts: [] },
    ])

    //#when
    const result = await fixEmptyMessagesWithSDK({
      sessionID: "ses_1",
      client,
      placeholderText: "[recovered]",
    })

    //#then
    expect(result.fixed).toBe(false)
    expect(result.scannedEmptyCount).toBe(0)
  })

  it("treats thinking-only messages as empty", async () => {
    //#given
    const { fixEmptyMessagesWithSDK } = await emptyContentRecoveryModulePromise
    const client = createMockClient([
      { info: { id: "msg_1" }, parts: [{ type: "thinking", text: "hmm" }] },
    ])
    mockReplaceEmptyTextParts.mockReturnValue(Promise.resolve(true))

    //#when
    const result = await fixEmptyMessagesWithSDK({
      sessionID: "ses_1",
      client,
      placeholderText: "[recovered]",
    })

    //#then
    expect(result.fixed).toBe(true)
    expect(result.fixedMessageIds).toContain("msg_1")
  })

  it("treats tool_use messages as non-empty", async () => {
    //#given
    const { fixEmptyMessagesWithSDK } = await emptyContentRecoveryModulePromise
    const client = createMockClient([
      { info: { id: "msg_1" }, parts: [{ type: "tool_use" }] },
    ])

    //#when
    const result = await fixEmptyMessagesWithSDK({
      sessionID: "ses_1",
      client,
      placeholderText: "[recovered]",
    })

    //#then
    expect(result.fixed).toBe(false)
    expect(result.scannedEmptyCount).toBe(0)
  })
})
