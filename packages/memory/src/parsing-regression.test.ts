import { describe, expect, it } from "vitest"
import {
  extractCitationReferences,
  extractMarkdownClaims,
  extractWikiLinks,
  FrontmatterParseError,
  lintMemory,
  parseFrontmatter,
  type MemoryPage
} from "./index.js"

describe("frontmatter parsing boundaries", () => {
  it("preserves quoted comments, escaped quotes and nested inline collections", () => {
    const parsed = parseFrontmatter(String.raw`---
quoted: "say \"hi\", # literal" # removed
single: 'it''s # literal'
nested: [one, {key: "a,b", list: [true, null, -2.5]}, 'x,y']
plain: value#literal # removed
---
body`)
    expect(parsed).toEqual({
      attributes: {
        quoted: 'say "hi", # literal',
        single: "it's # literal",
        nested: ["one", { key: "a,b", list: [true, null, -2.5] }, "x,y"],
        plain: "value#literal"
      },
      body: "body"
    })
  })

  it("advances through nested sequence mappings and preserves empty-value defaults", () => {
    const parsed = parseFrontmatter(`---
items:
  - name: first
    nested:
      flags: [true, false]
    empty:

    after: next
  -
  -
    child: value
empty:
last: done
---
`)
    expect(parsed.attributes).toEqual({
      items: [{ name: "first", nested: { flags: [true, false] }, empty: "", after: "next" }, null, { child: "value" }],
      empty: "",
      last: "done"
    })
  })

  it.each([
    ['value: {key: one, key: two}', 'duplicate key "key"', 1],
    ['items:\n  - name: one\n    name: two', 'duplicate key "name"', 3],
    ['items:\n  - name: one\n    invalid', 'invalid sequence mapping', 3],
    ['value: {broken}', 'invalid inline mapping', 1],
    ['value: !tag', 'YAML tags and aliases are not supported', 1],
    ['value: &anchor', 'YAML tags and aliases are not supported', 1],
    ['value: *alias', 'YAML tags and aliases are not supported', 1]
  ])("retains error locations for %s", (body, message, line) => {
    expect(() => parseFrontmatter(`---\n${body}\n---\n`)).toThrow(
      `${message} (frontmatter line ${line})`
    )
  })

  it("preserves BOM/CRLF bodies and accepts a closing delimiter at EOF", () => {
    expect(parseFrontmatter('\uFEFF---\r\nkey: true\r\n--- \r\n\r\nbody\r\n')).toEqual({
      attributes: { key: true }, body: '\r\nbody\r\n'
    })
    expect(parseFrontmatter('---\nkey: true\n---')).toEqual({ attributes: { key: true }, body: '' })
    expect(() => parseFrontmatter('---')).toThrow(FrontmatterParseError)
  })
})

describe("Markdown extraction boundaries", () => {
  it("keeps citation ordering and link positions across code and escaped markup", () => {
    const markdown = [
      '`` [[hidden]] [@hidden] `` [[Page#Section|label]] [@one; @two] [^three] {{cite:four}}',
      '\\[[escaped]] [[Next]] <!-- cite:five -->',
      '```',
      '[[fenced]] [@fenced]',
      '```',
      'Unclosed ` [[masked]] [@masked]'
    ].join('\n')
    expect(extractWikiLinks(markdown)).toEqual([
      { raw: '[[Page#Section|label]]', target: 'Page', anchor: 'Section', label: 'label', line: 1, column: 28 },
      { raw: '[[Next]]', target: 'Next', line: 2, column: 14 }
    ])
    expect(extractCitationReferences(markdown).map(({ id, line }) => ({ id, line }))).toEqual([
      { id: 'one', line: 1 }, { id: 'two', line: 1 }, { id: 'three', line: 1 },
      { id: 'four', line: 1 }, { id: 'five', line: 2 }
    ])
  })

  it("flushes claims when changing block kinds and between list and table rows", () => {
    expect(extractMarkdownClaims('First line\nsecond [@a]\n- List [@b]\n- Other\n> Quote\n> more\n| Cell |\n| Next |')).toEqual([
      { text: 'First line second [@a]', citationIds: ['a'], line: 1 },
      { text: 'List [@b]', citationIds: ['b'], line: 3 },
      { text: 'Other', citationIds: [], line: 4 },
      { text: 'Quote more', citationIds: [], line: 5 },
      { text: '| Cell |', citationIds: [], line: 7 },
      { text: '| Next |', citationIds: [], line: 8 }
    ])
  })

  it("reports missing anchors once per link while reusing cached target headings", () => {
    const page: MemoryPage = {
      id: 'page', path: 'page.md', title: 'Page', revision: 1, aliases: [], tags: [],
      sources: [], citations: [], relationships: [], metadata: { citationPolicy: 'none' },
      body: '# Present\n[[#Present]] [[#Missing]] [[Page#Missing]] [[Absent]]'
    }
    expect(lintMemory([page]).issues.map(({ code, message }) => ({ code, message }))).toEqual([
      { code: 'broken-reference', message: 'wikilink anchor "Missing" does not exist on ""' },
      { code: 'broken-reference', message: 'wikilink anchor "Missing" does not exist on "Page"' },
      { code: 'broken-reference', message: 'wikilink target "Absent" does not exist' }
    ])
  })
})
