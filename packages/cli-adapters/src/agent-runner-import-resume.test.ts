import { nativeCliEndpointId, type Session } from "@jingler/core"
import { describe, expect, it } from "vitest"
import { continuationFromImport } from "./agent-runner.js"

type Chat = Session["chats"][number]
type Prior = Parameters<typeof continuationFromImport>[2]
type Digest = Parameters<typeof continuationFromImport>[3]

const session = (importedFrom?: Session["importedFrom"]) =>
  ({ environmentId: "desktop", importedFrom }) as unknown as Session
const chat = (continuation?: Chat["continuation"]) => ({ continuation }) as unknown as Chat
const none: Prior = []
const oneMessage = [{}] as unknown as Prior

describe("continuationFromImport (#612)", () => {
  it("resumes the native claude session on the first message", () => {
    expect(
      continuationFromImport(session({ source: "claude-code", nativeSessionId: "abc" }), chat(), none, null)
    ).toEqual({ runtimeId: "claude", endpointId: nativeCliEndpointId("desktop", "claude"), id: "abc" })
  })

  it("uses the codex runtime for codex imports", () => {
    expect(
      continuationFromImport(session({ source: "codex", nativeSessionId: "xyz" }), chat(), none, null)
    ).toEqual({ runtimeId: "codex", endpointId: nativeCliEndpointId("desktop", "codex"), id: "xyz" })
  })

  it("keeps an existing chat continuation over the import", () => {
    const existing = { runtimeId: "claude", endpointId: "e", id: "live" } as unknown as Chat["continuation"]
    expect(
      continuationFromImport(session({ source: "claude-code", nativeSessionId: "abc" }), chat(existing), none, null)
    ).toBe(existing)
  })

  it("does not resume once the chat has messages", () => {
    expect(
      continuationFromImport(session({ source: "claude-code", nativeSessionId: "abc" }), chat(), oneMessage, null)
    ).toBeNull()
  })

  it("does not resume a session that was not imported", () => {
    expect(continuationFromImport(session(), chat(), none, null)).toBeNull()
  })

  it("drops continuation when a context digest is present", () => {
    expect(
      continuationFromImport(session({ source: "codex", nativeSessionId: "xyz" }), chat(), none, {} as unknown as Digest)
    ).toBeNull()
  })
})
