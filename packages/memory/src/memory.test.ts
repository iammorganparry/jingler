import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  MemoryAuditEvent,
  MemoryGraphEdge,
  MemoryMarkdownParseError,
  MemoryProposal,
  MemoryRevision,
  MemoryRole,
  MemorySource,
  assertMemoryValid,
  assertMemoryGraphEvidence,
  buildMemoryAnalytics,
  buildMemoryArtifacts,
  buildBacklinkIndex,
  buildMemoryGraph,
  canonicalJson,
  extractCitationReferences,
  extractWikiLinks,
  lintMemory,
  parseExportManifest,
  parseMemoryAnalytics,
  parseMemoryGraph,
  parseMemoryIndex,
  parseMemoryPage,
  serializeExportManifest,
  serializeMemoryAnalytics,
  serializeMemoryGraph,
  serializeMemoryIndex,
  serializeMemoryMarkdown,
  type MemoryGraph,
  type MemoryPage
} from "./index.js"

const overviewMarkdown = `---
id: project-overview
title: Project Overview
revision: 3
aliases:
  - Overview
  - Start here
tags: [project, canonical]
sources:
  - id: architecture
    kind: file
    title: Architecture guide
    uri: docs/architecture.md
citations:
  - id: architecture-contract
    sourceId: architecture
    locator: Persistence
relationships:
  - kind: dependency
    target: Agent Notes
  - kind: schema
    target: memory-page/v1
    label: Memory page schema
custom:
  owner: platform
  flags: [stable, shared]
---
# Project Overview

Jingler stores its durable state as files. [^architecture-contract]

See [[Agent Notes#Decisions|the decisions]]. [^architecture-contract]
`

const notesMarkdown = `---
id: agent-notes
path: notes/agent-notes.md
title: Agent Notes
revision: 1
aliases: [Notes]
tags: [agents]
sources: []
citations: []
citationPolicy: none
---
# Agent Notes

## Decisions

Notes can contain [[project-overview|backlinks]].
`

const pagesFixture = (): ReadonlyArray<MemoryPage> => [
  parseMemoryPage("overview.md", overviewMarkdown),
  parseMemoryPage("notes/agent-notes.md", notesMarkdown)
]

const auditEventsFixture = (): ReadonlyArray<MemoryAuditEvent> => [
  {
    id: "event-page-overview",
    type: "page.created",
    actorId: "agent-01",
    occurredAt: "2026-07-31T12:00:00Z",
    pageId: "project-overview",
    details: {}
  },
  {
    id: "event-revision-overview",
    type: "revision.created",
    actorId: "agent-02",
    occurredAt: "2026-08-01T12:00:00Z",
    pageId: "project-overview",
    revisionId: "overview-r3",
    details: {}
  },
  {
    id: "event-page-notes",
    type: "page.created",
    actorId: "agent-01",
    occurredAt: "2026-08-01T11:00:00Z",
    pageId: "agent-notes",
    details: {}
  }
]

const expectAcceptedGraphEvidence = (
  graph: MemoryGraph,
  pages: ReadonlyArray<MemoryPage>
): void => {
  const nodeIds = new Set(graph.nodes.map((node) => node.id))
  for (const edge of graph.edges) {
    expect(nodeIds.has(edge.sourceId)).toBe(true)
    expect(nodeIds.has(edge.targetId)).toBe(true)
    expect(edge.kind).toBe(edge.evidence.kind)
    const evidence = edge.evidence
    if (evidence.kind === "backlink") {
      const page = pages.find((candidate) => candidate.id === evidence.sourcePageId)
      expect(page?.body).toContain(evidence.raw)
    } else {
      const page = pages.find((candidate) => candidate.id === evidence.pageId)
      expect(page).toBeDefined()
      if (evidence.kind === "wikilink") {
        expect(page?.body).toContain(evidence.raw)
      } else if (evidence.kind === "citation") {
        expect(page?.body).toContain(evidence.raw)
        expect(page?.citations).toContainEqual(
          expect.objectContaining({ id: evidence.citationId, sourceId: evidence.sourceId })
        )
      } else {
        expect(page?.relationships[evidence.relationshipIndex]).toMatchObject({
          kind: evidence.kind,
          target: evidence.target
        })
      }
    }
  }
}

describe("memory schemas", () => {
  it("decode sources, revisions, proposals, roles, and audit events", () => {
    expect(
      Schema.decodeUnknownSync(MemorySource)({
        id: "architecture",
        kind: "file",
        title: "Architecture"
      }).id
    ).toBe("architecture")
    expect(
      Schema.decodeUnknownSync(MemoryRevision)({
        id: "overview-r3",
        pageId: "project-overview",
        revision: 3,
        contentHash: "sha256:abc",
        markdown: overviewMarkdown,
        authorId: "agent-01",
        createdAt: "2026-08-01T12:00:00Z"
      }).revision
    ).toBe(3)
    expect(
      Schema.decodeUnknownSync(MemoryProposal)({
        id: "proposal-1",
        pageId: "project-overview",
        baseRevisionId: "overview-r3",
        markdown: overviewMarkdown,
        proposedBy: "agent-01",
        createdAt: "2026-08-01T12:00:00Z",
        status: "open"
      }).status
    ).toBe("open")
    expect(
      Schema.decodeUnknownSync(MemoryRole)({
        principalId: "agent-01",
        role: "editor",
        scope: "workspace"
      }).role
    ).toBe("editor")
    expect(
      Schema.decodeUnknownSync(MemoryAuditEvent)({
        id: "event-1",
        type: "revision.created",
        actorId: "agent-01",
        occurredAt: "2026-08-01T12:00:00Z",
        revisionId: "overview-r3",
        details: { reason: "initial fixture" }
      }).type
    ).toBe("revision.created")
  })
})

describe("Markdown documents", () => {
  it("round-trips frontmatter, prose, citations, metadata, and wikilinks", () => {
    const page = parseMemoryPage("overview.md", overviewMarkdown)
    const serialized = serializeMemoryMarkdown(page)
    const reparsed = parseMemoryPage("overview.md", serialized)

    expect(reparsed).toEqual(page)
    expect(reparsed.body).toContain("[^architecture-contract]")
    expect(extractCitationReferences(reparsed.body).map((citation) => citation.id)).toEqual([
      "architecture-contract",
      "architecture-contract"
    ])
    expect(extractWikiLinks(reparsed.body)).toMatchObject([
      { target: "Agent Notes", anchor: "Decisions", label: "the decisions" }
    ])
    expect(reparsed.metadata).toEqual({ custom: { owner: "platform", flags: ["stable", "shared"] } })
    expect(reparsed.relationships).toEqual([
      { kind: "dependency", target: "Agent Notes" },
      { kind: "schema", target: "memory-page/v1", label: "Memory page schema" }
    ])
    expect(serializeMemoryMarkdown(reparsed)).toBe(serialized)
  })

  it("does not parse links or citations inside code", () => {
    // biome-ignore lint/security/noSecrets: this is Markdown syntax, not a credential.
    const markdown = "`[[inline]] [@inline]`\n\n```md\n[[fenced]] [^fenced]\n```\n\n[[real]] [@real]"
    expect(extractWikiLinks(markdown).map((link) => link.target)).toEqual(["real"])
    expect(extractCitationReferences(markdown).map((citation) => citation.id)).toEqual(["real"])
  })

  it("preserves CRLF prose and parses multi-source citations", () => {
    const markdown =
      '---\r\nid: crlf\r\ntitle: "CRLF"\r\nrevision: 1\r\ncitationPolicy: "none"\r\n---\r\n# CRLF\r\n\r\nBody [@one; @two].\r\n'
    const page = parseMemoryPage("crlf.md", markdown)

    expect(page.body).toBe("# CRLF\r\n\r\nBody [@one; @two].\r\n")
    expect(extractCitationReferences(page.body).map((citation) => citation.id)).toEqual([
      "one",
      "two"
    ])
  })

  it("rejects duplicate keys in block, sequence, and inline mappings", () => {
    const duplicateBlock = `---\nid: first\nid: second\ntitle: Duplicate\nrevision: 1\n---\n`
    const duplicateSequence = `---\nid: page\ntitle: Duplicate\nrevision: 1\nsources:\n  - id: source\n    id: duplicate\n    kind: manual\n    title: Source\n---\n`
    const duplicateInline = `---\nid: page\ntitle: Duplicate\nrevision: 1\ncustom: {owner: team, owner: other}\n---\n`

    expect(() => parseMemoryPage("duplicate.md", duplicateBlock)).toThrow(/duplicate key "id"/)
    expect(() => parseMemoryPage("duplicate.md", duplicateSequence)).toThrow(
      /duplicate key "id"/
    )
    expect(() => parseMemoryPage("duplicate.md", duplicateInline)).toThrow(
      /duplicate key "owner"/
    )
  })

  it("preserves source, citation, and relationship shorthand defaults", () => {
    const page = parseMemoryPage(
      "shorthand.md",
      `---
id: shorthand
title: Shorthand
revision: 1
sources:
  - id: evidence
citations: [evidence]
dependencies: [Agent Notes]
schemas: [memory-page/v1]
---
# Shorthand
`
    )

    expect(page.sources).toEqual([{ id: "evidence", kind: "other", title: "evidence" }])
    expect(page.citations).toEqual([{ id: "evidence", sourceId: "evidence" }])
    expect(page.relationships).toEqual([
      { kind: "dependency", target: "Agent Notes" },
      { kind: "schema", target: "memory-page/v1" }
    ])
    expect(() =>
      parseMemoryPage(
        "invalid.md",
        "---\nid: invalid\ntitle: Invalid\nsources: [{id: source, kind: invented}]\n---\n"
      )
    ).toThrow(MemoryMarkdownParseError)
  })
})

describe("memory lint", () => {
  it("accepts cited, linked, bounded pages", () => {
    const result = lintMemory(pagesFixture())
    expect(result).toMatchObject({ ok: true, errors: [] })
    expect(() => assertMemoryValid(pagesFixture())).not.toThrow()
  })

  it("rejects unsafe paths, duplicate identities, broken links, uncited claims, size, and credentials", () => {
    const base = parseMemoryPage(
      "../outside.md",
      `---
id: duplicate
title: Shared identity
revision: 1
aliases: []
tags: []
sources: []
citations: []
---
This claim has no evidence and links to [[missing-page]].

api_key = sk-test_secret_value_1234567890
`
    )
    const duplicate: MemoryPage = {
      ...base,
      path: "safe.md",
      body: "A second uncited claim.",
      metadata: { citationPolicy: "none" }
    }
    const result = lintMemory([base, duplicate], { maxPageBytes: 100 })
    const codes = new Set(result.errors.map((issue) => issue.code))

    expect(result.ok).toBe(false)
    expect(codes).toEqual(
      new Set([
        "unsafe-path",
        "duplicate-identity",
        "broken-reference",
        "uncited-claim",
        "oversized-page",
        "credential"
      ])
    )
    expect(result.errors.find((issue) => issue.code === "credential")?.message).not.toContain(
      "sk-test_secret_value"
    )
    expect(() => assertMemoryValid([base, duplicate], { maxPageBytes: 100 })).toThrow(
      /memory validation failed/
    )
  })

  it("rejects broken citations and proposals based on stale revisions", () => {
    const [overview, notes] = pagesFixture()
    const broken = {
      ...overview!,
      body: "A claim cites an unknown source. [@unknown]"
    }
    const revisions = [
      {
        id: "overview-r2",
        pageId: "project-overview",
        revision: 2,
        contentHash: "sha256:r2",
        markdown: "r2",
        authorId: "agent-01",
        createdAt: "2026-07-31T12:00:00Z"
      },
      {
        id: "overview-r3",
        pageId: "project-overview",
        revision: 3,
        parentRevisionId: "overview-r2",
        contentHash: "sha256:r3",
        markdown: "r3",
        authorId: "agent-01",
        createdAt: "2026-08-01T12:00:00Z"
      }
    ]
    const proposals: ReadonlyArray<MemoryProposal> = [
      {
        id: "proposal-stale",
        pageId: "project-overview",
        baseRevisionId: "overview-r2",
        markdown: "replacement",
        proposedBy: "agent-01",
        createdAt: "2026-08-01T12:01:00Z",
        status: "open"
      }
    ]
    const result = lintMemory({ pages: [broken, notes!], revisions, proposals })

    expect(result.errors.map((issue) => issue.code)).toContain("broken-citation")
    expect(result.errors.map((issue) => issue.code)).toContain("stale-base")
  })
})

describe("derived artifacts", () => {
  it("builds reproducible index, backlink, graph, analytics, and export artifacts", () => {
    const pages = pagesFixture()
    const events = auditEventsFixture()
    const forward = buildMemoryArtifacts(pages, [], events)
    const reverse = buildMemoryArtifacts([...pages].reverse(), [], [...events].reverse())

    expect(canonicalJson(reverse)).toBe(canonicalJson(forward))
    expect(forward.backlinks).toEqual({
      "agent-notes": ["project-overview"],
      "project-overview": ["agent-notes"]
    })
    expect(forward.graph.edges.map((edge) => edge.kind)).toEqual([
      "backlink",
      "wikilink",
      "backlink",
      "dependency",
      "wikilink",
      "schema",
      "citation",
      "citation"
    ])
    expectAcceptedGraphEvidence(forward.graph, pages)
    expect(() => assertMemoryGraphEvidence(forward.graph, pages)).not.toThrow()
    expect(forward.analytics).toMatchObject({
      pageCount: 2,
      sourceCount: 1,
      citationCount: 2,
      wikilinkCount: 2,
      relationshipCount: 2,
      eventCount: 3,
      actorCount: 2
    })
    expect(buildMemoryGraph(pages)).toEqual(forward.graph)
    expect(buildMemoryAnalytics(pages, events)).toEqual(forward.analytics)
    expect(parseMemoryIndex(serializeMemoryIndex(forward.index))).toEqual(forward.index)
    expect(parseMemoryGraph(serializeMemoryGraph(forward.graph))).toEqual(forward.graph)
    expect(parseMemoryAnalytics(serializeMemoryAnalytics(forward.analytics))).toEqual(
      forward.analytics
    )
    expect(parseExportManifest(serializeExportManifest(forward.manifest))).toEqual(forward.manifest)
    expect(buildMemoryArtifacts(pages, [], events).manifest).toEqual(forward.manifest)
  })

  it("rejects relationship edges without resolvable accepted evidence", () => {
    const [overview, notes] = pagesFixture()
    const broken: MemoryPage = {
      ...overview!,
      relationships: [{ kind: "dependency", target: "missing-page" }]
    }

    expect(lintMemory([broken, notes!]).errors.map((issue) => issue.code)).toContain(
      "broken-reference"
    )
    expect(() => buildMemoryGraph([broken, notes!])).toThrow(/does not resolve/)
    expect(buildBacklinkIndex([broken, notes!])).toEqual({
      "agent-notes": ["project-overview"],
      "project-overview": ["agent-notes"]
    })
  })

  it("rejects graph edges whose relationship kind and evidence disagree", () => {
    expect(() =>
      Schema.decodeUnknownSync(MemoryGraphEdge)({
        sourceId: "page:project-overview",
        targetId: "source:architecture",
        kind: "wikilink",
        evidence: {
          kind: "citation",
          pageId: "project-overview",
          path: "overview.md",
          citationId: "architecture-contract",
          sourceId: "architecture",
          line: 3,
          column: 42,
          raw: "[^architecture-contract]"
        }
      })
    ).toThrow(/kind must match/)
  })
})
