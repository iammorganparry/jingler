import { Either, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { FALLBACK_MODELS, ModelOption, defaultModel } from "./models.js"

/**
 * Model options cross the RPC boundary (the composer's model chip). What matters:
 * the schema round-trips, every harness has at least one fallback, and the
 * default is the first fallback option.
 */

describe("ModelOption", () => {
  it("round-trips through encode → decode", () => {
    const option: ModelOption = { id: "opus", label: "opus" }
    expect(Schema.decodeUnknownSync(ModelOption)(Schema.encodeSync(ModelOption)(option))).toStrictEqual(option)
  })

  it("rejects a malformed option", () => {
    expect(Either.isLeft(Schema.decodeUnknownEither(ModelOption)({ id: 5 }))).toBe(true)
  })
})

describe("FALLBACK_MODELS / defaultModel", () => {
  it("gives every harness a non-empty fallback list", () => {
    expect(FALLBACK_MODELS.claude.length).toBeGreaterThan(0)
    expect(FALLBACK_MODELS.codex.length).toBeGreaterThan(0)
    expect(FALLBACK_MODELS.cursor.length).toBeGreaterThan(0)
  })

  it("defaults to the first fallback option per harness", () => {
    expect(defaultModel("claude")).toBe(FALLBACK_MODELS.claude[0]!.id)
    expect(defaultModel("claude")).toBe("opus")
    expect(defaultModel("codex")).toBe(FALLBACK_MODELS.codex[0]!.id)
  })

  it("offers the current Claude Code model picker catalogue", () => {
    expect(FALLBACK_MODELS.claude).toStrictEqual([
      { id: "opus", label: "Opus 5" },
      { id: "claude-opus-5", label: "Opus 5 (pinned)" },
      { id: "claude-opus-4-8", label: "Opus 4.8" },
      { id: "claude-opus-4-8[1m]", label: "Opus 4.8 1M" },
      { id: "claude-opus-4-7[1m]", label: "Opus 4.7 1M" },
      { id: "claude-opus-4-6[1m]", label: "Opus 4.6 1M" },
      { id: "sonnet[1m]", label: "Sonnet 5 1M" },
      { id: "claude-sonnet-4-6[1m]", label: "Sonnet 4.6 1M" },
      { id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
      { id: "haiku", label: "Haiku 4.5" },
      { id: "claude-fable-5", label: "Fable 5" }
    ])
  })
})
