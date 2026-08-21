import { Either, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { ExplanationDocument, ExplanationPayload, VisualBlock } from "./explanation-document.js"
import { PlanBlock, PlanPrd } from "./plan-document.js"

const payload = {
  title: "How plan publishing works",
  summary: "The agent publishes a typed document that the renderer watches.",
  sections: [
    {
      id: "flow",
      title: "Runtime flow",
      blocks: [
        { kind: "prose", id: "intro", text: "Publishing crosses one typed boundary." },
        { kind: "code", id: "tree", language: "text", code: "agent\n  publish\n    store" },
        { kind: "diagram", id: "sequence", source: "sequenceDiagram\n  Agent->>Store: publish" }
      ]
    }
  ]
}

describe("explanation document schemas", () => {
  it("decodes a complete visual explanation", () => {
    expect(Either.isRight(Schema.decodeUnknownEither(ExplanationPayload)(payload))).toBe(true)
    expect(
      Either.isRight(
        Schema.decodeUnknownEither(ExplanationDocument)({
          id: "explanation-1",
          sessionId: "session-1",
          producingChatId: "chat-1",
          revision: 1,
          ...payload,
          updatedAt: "2026-08-12T12:00:00.000Z"
        })
      )
    ).toBe(true)
  })

  it("rejects unsupported block kinds", () => {
    const invalid = structuredClone(payload)
    invalid.sections[0]!.blocks.push({
      kind: "html",
      id: "unsafe",
      source: "unsupported"
    } as never)
    expect(Either.isLeft(Schema.decodeUnknownEither(ExplanationPayload)(invalid))).toBe(true)
  })

  it("preserves PlanBlock compatibility", () => {
    const block = { kind: "table", id: "shape", headers: ["Input"], rows: [["Prompt"]] }
    expect(Schema.decodeUnknownSync(VisualBlock)(block)).toEqual(Schema.decodeUnknownSync(PlanBlock)(block))
    expect(
      Either.isRight(
        Schema.decodeUnknownEither(PlanPrd)({
          title: "Existing plan",
          sections: [{ id: "context", title: "Context", blocks: [block] }],
          stages: [],
          annotations: []
        })
      )
    ).toBe(true)
  })
})
