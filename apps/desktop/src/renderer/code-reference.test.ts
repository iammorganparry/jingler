import { describe, expect, it } from "vitest"
import {
  appendCodeReferencesToPrompt,
  codeReferenceDisplayLabel,
  deduplicateCodeReferences,
  normalizeCodeReference,
  serializeCodeReferences,
  type CodeReference
} from "./code-reference.js"

const reference = (overrides: Partial<CodeReference> = {}): CodeReference => ({
  path: "src/parser.ts",
  startLine: 12,
  endLine: 15,
  source: "const parsed = parse(input)\nreturn parsed",
  ...overrides
})

describe("code references", () => {
  it("normalizes repository paths and reversed inclusive ranges without changing source", () => {
    const source = "  first\r\nsecond  "
    expect(
      normalizeCodeReference({
        path: " ./src\\feature/../parser [new].ts ",
        startLine: 15,
        endLine: 12,
        source
      })
    ).toEqual({
      path: "src/parser [new].ts",
      startLine: 12,
      endLine: 15,
      source
    })
  })

  it("rejects invalid and repository-escaping locations", () => {
    expect(normalizeCodeReference(reference({ path: "/tmp/a.ts" }))).toBeNull()
    expect(normalizeCodeReference(reference({ path: "../../a.ts" }))).toBeNull()
    expect(normalizeCodeReference(reference({ startLine: 0 }))).toBeNull()
    expect(normalizeCodeReference({ ...reference(), source: 42 })).toBeNull()
  })
})

describe("code reference identity and display", () => {
  it("deduplicates a normalized path and range while preserving first-seen order", () => {
    expect(
      deduplicateCodeReferences([
        reference({ path: "./src/parser.ts", startLine: 15, endLine: 12 }),
        reference({ source: "a newer capture of the same location" }),
        reference({
          path: "src/other.ts",
          startLine: 2,
          endLine: 2,
          source: "other"
        })
      ])
    ).toEqual([
      reference(),
      reference({
        path: "src/other.ts",
        startLine: 2,
        endLine: 2,
        source: "other"
      })
    ])
  })

  it("formats a repository path with its inclusive line range", () => {
    expect(codeReferenceDisplayLabel(reference())).toBe("src/parser.ts:L12\u2013L15")
    expect(codeReferenceDisplayLabel(reference({ startLine: 12, endLine: 12 }))).toBe(
      "src/parser.ts:L12"
    )
  })
})

describe("code reference prompt serialization", () => {
  it("serializes exact captured source behind a language-neutral collision-safe fence", () => {
    const source = "const markdown = `value`\n```\nkeep trailing spaces  "
    const serialized = serializeCodeReferences([reference({ source })])

    expect(serialized).toContain('Path: "src/parser.ts"')
    expect(serialized).toContain("Lines: 12-15 (inclusive)")
    expect(serialized).toContain(`Source:\n\`\`\`\`\n${source}\n\`\`\`\``)
    expect(serialized).not.toContain("```ts")
  })

  it("appends context after the message and supports a reference-only prompt", () => {
    const withMessage = appendCodeReferencesToPrompt("Please explain this", [reference()])
    expect(withMessage.startsWith("Please explain this\n\n<repository-code-references>")).toBe(true)

    const referenceOnly = appendCodeReferencesToPrompt("", [reference()])
    expect(referenceOnly.startsWith("<repository-code-references>")).toBe(true)
    expect(appendCodeReferencesToPrompt("unchanged", [])).toBe("unchanged")
  })
})
