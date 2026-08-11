import { describe, expect, it } from "vitest"
import { normalizePiEvent } from "./pi-events.js"

describe("pi event normalization", () => {
  it("normalizes streamed text and tool lifecycle", () => {
    expect(
      normalizePiEvent({
        type: "message_update",
        message: {} as never,
        assistantMessageEvent: { type: "text_delta", delta: "hello" } as never
      })
    ).toEqual({ _tag: "Assistant", text: "hello" })
    expect(
      normalizePiEvent({
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "workspace.read",
        args: { path: "src/read.ts" }
      })
    ).toMatchObject({
      _tag: "ToolStart",
      id: "call-1",
      name: "workspace.read",
      target: "src/read.ts"
    })
    expect(
      normalizePiEvent({
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "workspace.read",
        result: { content: [{ type: "text", text: "result" }] },
        isError: false
      })
    ).toMatchObject({
      _tag: "ToolEnd",
      id: "call-1",
      status: "success",
      output: "result"
    })
  })

  it("normalizes provider failures without exposing reasoning", () => {
    expect(
      normalizePiEvent({
        type: "message_update",
        message: {} as never,
        assistantMessageEvent: {
          type: "error",
          reason: "error",
          error: { errorMessage: "rate limited" }
        } as never
      })
    ).toEqual({ _tag: "Failed", message: "rate limited" })
  })

  it("includes the resolved model context window in usage", () => {
    expect(
      normalizePiEvent(
        {
          type: "message_end",
          message: {
            role: "assistant",
            usage: { totalTokens: 42_100 }
          } as never
        },
        128_000
      )
    ).toEqual({ _tag: "Usage", tokens: 42_100, window: 128_000 })
  })

  it("derives bounded file targets from schema-validated tool arguments", () => {
    expect(
      normalizePiEvent({
        type: "tool_execution_start",
        toolCallId: "rename-1",
        toolName: "workspace_rename",
        args: { from: "src/old.ts", to: "src/new.ts", ignored: "secret" }
      })
    ).toMatchObject({ target: "src/old.ts → src/new.ts" })
    expect(
      normalizePiEvent({
        type: "tool_execution_start",
        toolCallId: "invalid-1",
        toolName: "workspace_read_file",
        args: { path: 42 }
      })
    ).toMatchObject({ target: null })
  })
})

describe("pi retry and compaction events", () => {
  it("normalizes retry and compaction lifecycle", () => {
    expect(
      normalizePiEvent({
        type: "auto_retry_start",
        attempt: 2,
        maxAttempts: 3,
        delayMs: 500,
        errorMessage: "rate limited"
      })
    ).toEqual({
      _tag: "RetryScheduled",
      operation: "provider",
      attempt: 2,
      maxAttempts: 3,
      delayMs: 500,
      message: "rate limited"
    })
    expect(
      normalizePiEvent({
        type: "compaction_end",
        reason: "threshold",
        result: {
          summary: "redacted from the event",
          firstKeptEntryId: "entry-1",
          tokensBefore: 9_000,
          estimatedTokensAfter: 3_000
        },
        aborted: false,
        willRetry: false
      })
    ).toEqual({
      _tag: "CompactionFinished",
      reason: "threshold",
      status: "success",
      tokensBefore: 9_000,
      tokensAfter: 3_000,
      message: null
    })
  })
})

describe("pi file-change events", () => {
  it("normalizes authoritative file-change evidence from tool details", () => {
    const fileChanges = {
      id: "set-1",
      callId: "call-1",
      changes: [
        {
          status: "A",
          path: "src/new.ts",
          oldPath: null,
          added: 2,
          removed: 0,
          binary: false,
          noNewlineAtEnd: false,
          beforeBytes: null,
          afterBytes: 10,
          preview: "+new",
          patchArtifactId: "artifact-1"
        }
      ],
      totals: { added: 2, removed: 0 },
      authoritative: true,
      reconciledAt: "2026-08-10T00:00:00.000Z"
    }
    expect(
      normalizePiEvent({
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "workspace.write",
        result: { content: [], details: { fileChanges } },
        isError: false
      })
    ).toMatchObject({
      _tag: "ToolEnd",
      diff: { added: 2, removed: 0 },
      preview: "+new",
      fileChanges
    })
  })

  it("keeps valid diff evidence when unrelated result content is malformed", () => {
    const fileChanges = {
      id: "set-2",
      callId: "call-2",
      changes: [],
      totals: { added: 0, removed: 0 },
      authoritative: true,
      reconciledAt: "2026-08-10T00:00:00.000Z"
    }
    expect(
      normalizePiEvent({
        type: "tool_execution_end",
        toolCallId: "call-2",
        toolName: "workspace.write",
        result: { content: "invalid", details: { fileChanges } },
        isError: false
      })
    ).toMatchObject({ _tag: "ToolEnd", fileChanges })
  })
})
