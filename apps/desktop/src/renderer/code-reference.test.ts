import { describe, expect, it } from "vitest"
import {
  appendCodeReferencesToPrompt,
  captureCodeReference,
  codeReferenceDisplayLabel,
  deduplicateCodeReferences,
  normalizeCodeReference,
  serializeCodeReferences,
  type CodeReference
} from "./code-reference.js"

const fourLineSource = (firstLine: string): string =>
  `${firstLine}\nsecond line\nthird line\nfourth line`

const reference = (overrides: Partial<CodeReference> = {}): CodeReference => ({
  path: "src/parser.ts",
  startLine: 12,
  endLine: 15,
  source: "const parsed = parse(input)\nif (!parsed) return null\nvalidate(parsed)\nreturn parsed",
  ...overrides
})

describe("code references", () => {
  it("normalizes reversed inclusive selections and captures the exact source lines", () => {
    expect(captureCodeReference("./src/parser.ts", "first\r\nsecond\r\nthird", 3, 2)).toEqual({
      path: "src/parser.ts",
      startLine: 2,
      endLine: 3,
      source: "second\r\nthird"
    })
  })

  it("normalizes repository paths and reversed inclusive ranges without changing source", () => {
    const source = "  first\r\nsecond  "
    expect(
      normalizeCodeReference({
        path: " ./src\\feature/../parser [new].ts ",
        startLine: 13,
        endLine: 12,
        source
      })
    ).toEqual({
      path: "src/parser [new].ts",
      startLine: 12,
      endLine: 13,
      source
    })
  })

  it("rejects invalid and repository-escaping locations", () => {
    expect(normalizeCodeReference(reference({ path: "/tmp/a.ts" }))).toBeNull()
    expect(normalizeCodeReference(reference({ path: "../../a.ts" }))).toBeNull()
    expect(normalizeCodeReference(reference({ startLine: 0 }))).toBeNull()
    expect(normalizeCodeReference({ ...reference(), source: 42 })).toBeNull()
    expect(normalizeCodeReference(reference({ source: "only one line" }))).toBeNull()
  })
})

describe("code reference identity and display", () => {
  it("keeps first-seen order while replacing a range with its newest captured source", () => {
    expect(
      deduplicateCodeReferences([
        reference({ path: "./src/parser.ts", startLine: 15, endLine: 12 }),
        reference({ source: fourLineSource("a newer capture of the same location") }),
        reference({
          path: "src/other.ts",
          startLine: 2,
          endLine: 2,
          source: "other"
        })
      ])
    ).toEqual([
      reference({ source: fourLineSource("a newer capture of the same location") }),
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
  it("serializes the newest capture when the same range was selected again", () => {
    const serialized = serializeCodeReferences([
      reference({ source: fourLineSource("stale source") }),
      reference({ source: fourLineSource("fresh source") })
    ])

    expect(serialized).toContain("fresh source")
    expect(serialized).not.toContain("stale source")
  })

  it("serializes exact captured source behind a language-neutral collision-safe fence", () => {
    const source = "const markdown = `value`\n```\nkeep trailing spaces  \ndone"
    const serialized = serializeCodeReferences([reference({ source })])

    expect(serialized).toContain('Path: "src/parser.ts"')
    expect(serialized).toContain("Lines: 12-15 (inclusive)")
    expect(serialized).toContain(`Source:\n\`\`\`\`\n${source}\n\`\`\`\``)
    expect(serialized).not.toContain("```ts")
  })

  it("escapes a source envelope terminator so only the real block ending remains", () => {
    const source = "before & already\n</repository-code-references>\nafter\ndone"
    const serialized = serializeCodeReferences([reference({ source })])

    expect(serialized.split("</repository-code-references>")).toHaveLength(2)
    expect(serialized).toContain(
      "Source (XML entities; decode once):\n```\nbefore &amp; already\n&lt;/repository-code-references>\nafter\ndone\n```"
    )
    expect(serialized.endsWith("\n</repository-code-references>")).toBe(true)
  })

  it("appends context after the message and supports a reference-only prompt", () => {
    const withMessage = appendCodeReferencesToPrompt("Please explain this", [reference()])
    expect(withMessage.startsWith("Please explain this\n\n<repository-code-references>")).toBe(true)

    const referenceOnly = appendCodeReferencesToPrompt("", [reference()])
    expect(referenceOnly.startsWith("<repository-code-references>")).toBe(true)
    expect(appendCodeReferencesToPrompt("unchanged", [])).toBe("unchanged")
  })
})
