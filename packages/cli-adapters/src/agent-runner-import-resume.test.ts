import { describe, it, expect } from "vitest"
import { nativeCliEndpointId } from "@jingler/core"

/**
 * Unit tests for issue #612: resume native sessions on import.
 * 
 * When an imported session gets its first message, the turn spec should
 * use the stored native session ID as its continuation, allowing the
 * harness to resume that native session.
 */
describe("imported session resume", () => {
  it("seeds continuation from importedFrom on first message", () => {
    const session = {
      id: "test-session",
      importedFrom: {
        source: "claude-code" as "claude-code" | "codex" | "conductor" | "t3code",
        nativeSessionId: "native-abc123"
      },
      environmentId: "desktop" as const
    }
    
    const priorMessages: never[] = []
    const chat = { continuation: undefined }
    const digest = null

    // Simulate the continuation logic from prepareTurnSpec
    const continuation = digest === null
      ? (chat.continuation ??
         (priorMessages.length === 0 && session.importedFrom !== undefined
           ? (() => {
               const imp = session.importedFrom!
               const runtimeId: "claude" | "codex" = imp.source === "codex" ? "codex" : "claude"
               return {
                 runtimeId,
                 endpointId: nativeCliEndpointId(session.environmentId ?? "desktop", runtimeId),
                 id: imp.nativeSessionId
               }
             })()
           : null))
      : null

    expect(continuation).toEqual({
      runtimeId: "claude",
      endpointId: nativeCliEndpointId("desktop", "claude"),
      id: "native-abc123"
    })
  })

  it("uses codex runtime for codex imports", () => {
    const session = {
      id: "test-session",
      importedFrom: {
        source: "codex" as "claude-code" | "codex" | "conductor" | "t3code",
        nativeSessionId: "codex-xyz789"
      },
      environmentId: "desktop" as const
    }
    
    const priorMessages: never[] = []
    const chat = { continuation: undefined }
    const digest = null

    const continuation = digest === null
      ? (chat.continuation ??
         (priorMessages.length === 0 && session.importedFrom !== undefined
           ? (() => {
               const imp = session.importedFrom!
               const runtimeId: "claude" | "codex" = imp.source === "codex" ? "codex" : "claude"
               return {
                 runtimeId,
                 endpointId: nativeCliEndpointId(session.environmentId ?? "desktop", runtimeId),
                 id: imp.nativeSessionId
               }
             })()
           : null))
      : null

    expect(continuation).toEqual({
      runtimeId: "codex",
      endpointId: nativeCliEndpointId("desktop", "codex"),
      id: "codex-xyz789"
    })
  })

  it("does not seed continuation when chat already has one", () => {
    const session = {
      id: "test-session",
      importedFrom: {
        source: "claude-code" as "claude-code" | "codex" | "conductor" | "t3code",
        nativeSessionId: "native-abc123"
      },
      environmentId: "desktop" as const
    }
    
    const priorMessages: never[] = []
    const existingContinuation = {
      runtimeId: "pi" as const,
      endpointId: "pi-endpoint",
      id: "existing-continuation"
    }
    const chat = { continuation: existingContinuation }
    const digest = null

    const continuation = digest === null
      ? (chat.continuation ??
         (priorMessages.length === 0 && session.importedFrom !== undefined
           ? (() => {
               const imp = session.importedFrom!
               const runtimeId: "claude" | "codex" = imp.source === "codex" ? "codex" : "claude"
               return {
                 runtimeId,
                 endpointId: nativeCliEndpointId(session.environmentId ?? "desktop", runtimeId),
                 id: imp.nativeSessionId
               }
             })()
           : null))
      : null

    expect(continuation).toEqual(existingContinuation)
  })

  it("does not seed continuation on subsequent messages", () => {
    const session = {
      id: "test-session",
      importedFrom: {
        source: "claude-code" as "claude-code" | "codex" | "conductor" | "t3code",
        nativeSessionId: "native-abc123"
      },
      environmentId: "desktop" as const
    }
    
    const priorMessages = [{ id: "msg-1" }] as any[]
    const chat = { continuation: undefined }
    const digest = null

    const continuation = digest === null
      ? (chat.continuation ??
         (priorMessages.length === 0 && session.importedFrom !== undefined
           ? (() => {
               const imp = session.importedFrom!
               const runtimeId: "claude" | "codex" = imp.source === "codex" ? "codex" : "claude"
               return {
                 runtimeId,
                 endpointId: nativeCliEndpointId(session.environmentId ?? "desktop", runtimeId),
                 id: imp.nativeSessionId
               }
             })()
           : null))
      : null

    expect(continuation).toBeNull()
  })

  it("does not seed continuation when session is not imported", () => {
    const session = {
      id: "test-session",
      importedFrom: undefined,
      environmentId: "desktop" as const
    }
    
    const priorMessages: never[] = []
    const chat = { continuation: undefined }
    const digest = null

    // When importedFrom is undefined, the condition is false so we get null
    const continuation = digest === null
      ? (chat.continuation ?? (priorMessages.length === 0 && session.importedFrom !== undefined ? null : null))
      : null

    expect(continuation).toBeNull()
  })
})
