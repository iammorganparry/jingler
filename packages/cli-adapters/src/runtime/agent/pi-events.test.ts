import { describe, expect, it } from "vitest"
import { normalizePiEvent } from "./pi-events.js"

describe("pi event normalization", () => {
  it("normalizes streamed text and tool lifecycle", () => {
    expect(normalizePiEvent({
      type: "message_update",
      message: {} as never,
      assistantMessageEvent: { type: "text_delta", delta: "hello" } as never
    })).toEqual({ _tag: "Assistant", text: "hello" })
    expect(normalizePiEvent({
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "workspace.read",
      args: {}
    })).toMatchObject({ _tag: "ToolStart", id: "call-1", name: "workspace.read" })
    expect(normalizePiEvent({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "workspace.read",
      result: { content: [{ type: "text", text: "result" }] },
      isError: false
    })).toMatchObject({ _tag: "ToolEnd", id: "call-1", status: "success", output: "result" })
  })

  it("normalizes provider failures without exposing reasoning", () => {
    expect(normalizePiEvent({
      type: "message_update",
      message: {} as never,
      assistantMessageEvent: {
        type: "error",
        reason: "error",
        error: { errorMessage: "rate limited" }
      } as never
    })).toEqual({ _tag: "Failed", message: "rate limited" })
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
