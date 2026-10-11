import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  MemoryAuditEvent,
  MemoryGraphEdge,
  MemoryCompilerCandidateResult,
  MemoryRelationshipCandidate,
  MemoryRelationshipEvidence,
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

const acceptedRelationshipsFixture = (
  pages: ReadonlyArray<MemoryPage>
): ReadonlyArray<MemoryRelationshipEvidence> => {
  const byId = new Map(pages.map((page) => [page.id, page]))
  const evidence = (
    id: string,
    kind: MemoryRelationshipEvidence["kind"],
    sourcePageId: string,
    targetPageId: string,
    quote: string
  ): MemoryRelationshipEvidence => {
    const source = byId.get(sourcePageId)
    const start = source?.body.indexOf(quote) ?? -1
    if (start < 0) throw new Error(`fixture evidence ${id} is missing`)
    return {
      id: `evidence:${id}`,
      relationshipId: `relationship:${id}`,
      kind,
      sourcePageId,
      targetPageId,
      sourceRevisionId: `revision:${sourcePageId}`,
      start,
      end: start + quote.length,
      quote,
      compilerEvidence: { sourceId: "architecture", start: 0, end: quote.length, quote },
      acceptedBy: "reviewer-01",
      acceptedAt: "2026-08-06T12:00:00.000Z"
    }
  }
  return [
    evidence(
      "overview-notes-wikilink",
      "wikilink",
      "project-overview",
      "agent-notes",
      "See [[Agent Notes#Decisions|the decisions]]."
    ),
    evidence(
      "notes-overview-wikilink",
      "wikilink",
      "agent-notes",
      "project-overview",
      "Notes can contain [[project-overview|backlinks]]."
    ),
    evidence(
      "overview-notes-dependency",
      "dependency",
      "project-overview",
      "agent-notes",
      "Jingler stores its durable state as files."
    )
  ]
}

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
      expect(page?.body.slice(evidence.start, evidence.end)).toBe(evidence.raw)
    } else {
      const page = pages.find((candidate) => candidate.id === evidence.pageId)
      expect(page).toBeDefined()
      if (evidence.kind === "wikilink") {
        expect(page?.body.slice(evidence.start, evidence.end)).toBe(evidence.raw)
      } else if (evidence.kind === "citation") {
        expect(page?.body).toContain(evidence.raw)
        expect(page?.citations).toContainEqual(
          expect.objectContaining({ id: evidence.citationId, sourceId: evidence.sourceId })
        )
      } else if (evidence.kind === "dependency") {
        expect(page?.body.slice(evidence.start, evidence.end)).toBe(evidence.raw)
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

  it("decodes structured compiler candidates and a valid empty learning result", () => {
    const candidate = Schema.decodeUnknownSync(MemoryCompilerCandidateResult)({
      status: "candidates",
      candidates: [
        {
          claim: "Refund retries share one concurrency limiter across workers.",
          evidence: {
            sourceId: "session-redacted",
            start: 12,
            end: 72,
            quote: "Refund retries share one concurrency limiter across workers."
          },
          durabilityReason: "verified_finding",
          sensitivity: "standard",
          targetIdentity: {
            action: "update",
            pageId: "refund-retries",
            revisionId: "refund-retries-r2"
          },
          relationshipSuggestions: [{ kind: "dependency", target: "job-limiter" }]
        }
      ]
    })
    expect(candidate.status).toBe("candidates")

    expect(
      Schema.decodeUnknownSync(MemoryCompilerCandidateResult)({
        status: "no_durable_learning",
        reason: "all_filtered",
        candidates: []
      })
    ).toEqual({ status: "no_durable_learning", reason: "all_filtered", candidates: [] })
  })

  it("rejects compiler candidates without an exact evidence span or with an invalid empty result", () => {
    expect(() =>
      Schema.decodeUnknownSync(MemoryCompilerCandidateResult)({
        status: "candidates",
        candidates: [
          {
            claim: "A standalone durable claim with invalid evidence offsets.",
            evidence: { sourceId: "source", start: 20, end: 10, quote: "invalid" },
            durabilityReason: "verified_finding",
            sensitivity: "standard",
            targetIdentity: {
              action: "create",
              pageId: "candidate",
              path: "learnings/candidate.md",
              title: "Candidate"
            },
            relationshipSuggestions: []
          }
        ]
      })
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(MemoryCompilerCandidateResult)({
        status: "no_durable_learning",
        reason: "all_filtered",
        candidates: [
          {
            claim: "An empty result cannot contain a durable candidate.",
            evidence: { sourceId: "source", start: 0, end: 8, quote: "evidence" },
            durabilityReason: "verified_finding",
            sensitivity: "standard",
            targetIdentity: {
              action: "create",
              pageId: "candidate",
              path: "learnings/candidate.md",
              title: "Candidate"
            },
            relationshipSuggestions: []
          }
        ]
      })
    ).toThrow()
  })

  it("decodes independently reviewable relationship candidates and stable accepted evidence", () => {
    const candidate = Schema.decodeUnknownSync(MemoryRelationshipCandidate)({
      id: "relationship:refunds:limiter",
      kind: "dependency",
      sourcePageId: "refund-retries",
      targetPageId: "job-limiter",
      claim: "Refund retries depend on the shared job limiter.",
      compilerEvidence: {
        sourceId: "session-redacted",
        start: 10,
        end: 58,
        quote: "Refund retries depend on the shared job limiter."
      },
      proposedBy: "agent-01",
      createdAt: "2026-08-06T10:00:00Z",
      status: "open"
    })
    expect(candidate.status).toBe("open")

    const accepted = Schema.decodeUnknownSync(MemoryRelationshipEvidence)({
      id: "evidence:relationship:refunds:limiter",
      relationshipId: candidate.id,
      kind: candidate.kind,
      sourcePageId: candidate.sourcePageId,
      targetPageId: candidate.targetPageId,
      sourceRevisionId: "revision:refund-retries:3",
      start: 0,
      end: candidate.claim.length,
      quote: candidate.claim,
      compilerEvidence: candidate.compilerEvidence,
      acceptedBy: "reviewer-01",
      acceptedAt: "2026-08-06T11:00:00Z"
    })
    expect(accepted.relationshipId).toBe(candidate.id)
  })

  it("rejects self-links and accepted relationship candidates without review metadata", () => {
    expect(() =>
      Schema.decodeUnknownSync(MemoryRelationshipCandidate)({
        id: "relationship:self",
        kind: "wikilink",
        sourcePageId: "same-page",
        targetPageId: "same-page",
        claim: "The page relates to itself.",
        compilerEvidence: { sourceId: "source", start: 0, end: 25, quote: "The page relates to itself." },
        proposedBy: "agent-01",
        createdAt: "2026-08-06T10:00:00Z",
        status: "open"
      })
    ).toThrow()

    expect(() =>
      Schema.decodeUnknownSync(MemoryRelationshipCandidate)({
        id: "relationship:unreviewed",
        kind: "dependency",
        sourcePageId: "source-page",
        targetPageId: "target-page",
        claim: "The source depends on the target.",
        compilerEvidence: { sourceId: "source", start: 0, end: 33, quote: "The source depends on the target." },
        proposedBy: "agent-01",
        createdAt: "2026-08-06T10:00:00Z",
        status: "accepted"
      })
    ).toThrow()
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

  it("requires claim citations to resolve through registered citation records", () => {
    const page = parseMemoryPage("fake-evidence.md", `---
id: fake-evidence
title: Fake evidence
revision: 1
sources: []
citations: []
---
# Fake evidence

This claim invents a local footnote. [^fake]

[^fake]: This definition is not registered evidence.
`)
    expect(lintMemory([page], { requireCitations: true }).errors.map((issue) => issue.code))
      .toEqual(expect.arrayContaining(["broken-citation", "uncited-claim"]))
  })

  it("treats each list item as an independent claim", () => {
    const page = parseMemoryPage("list-claims.md", `---
id: list-claims
title: List claims
revision: 1
sources:
  - id: source
    kind: manual
    title: Source
citations:
  - id: evidence
    sourceId: source
---
# List claims

- Unsupported first claim.
- Supported second claim. [@evidence]
`)
    const uncited = lintMemory([page], { requireCitations: true }).errors.filter(
      (issue) => issue.code === "uncited-claim"
    )
    expect(uncited).toHaveLength(1)
    expect(uncited[0]?.line).toBe(3)
  })

  it("reserves generated Obsidian export namespaces and detects common credentials", () => {
    const page: MemoryPage = {
      ...pagesFixture()[0]!,
      id: "reserved-export",
      path: "_jingler/Index.md",
      body: "secret=abcdefghijklmnop [@architecture-contract]"
    }
    const codes = lintMemory([page], { requireCitations: true }).errors.map((issue) => issue.code)
    expect(codes).toEqual(expect.arrayContaining(["unsafe-path", "credential"]))
  })

  it("keeps prose, quotes, and missing-source citations as separate unsupported claims", () => {
    const page = parseMemoryPage("boundaries.md", `---
id: boundaries
title: Boundaries
revision: 1
citations:
  - id: missing-evidence
    sourceId: missing-source
---
# Boundaries

Unsupported standalone claim.
> Quoted claim. [@missing-evidence]
`)
    const errors = lintMemory([page], { requireCitations: true }).errors
    expect(errors.filter((issue) => issue.code === "uncited-claim")).toHaveLength(2)
    expect(errors.some((issue) => issue.code === "broken-citation")).toBe(true)
  })
})

describe("derived artifacts", () => {
  it("builds reproducible index, backlink, graph, analytics, and export artifacts", () => {
    const pages = pagesFixture()
    const events = auditEventsFixture()
    const relationships = acceptedRelationshipsFixture(pages)
    const forward = buildMemoryArtifacts(pages, [], events, relationships)
    const reverse = buildMemoryArtifacts(
      [...pages].reverse(),
      [],
      [...events].reverse(),
      [...relationships].reverse()
    )

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
    expect(() => assertMemoryGraphEvidence(forward.graph, pages, [], relationships)).not.toThrow()
    expect(forward.analytics).toMatchObject({
      pageCount: 2,
      sourceCount: 1,
      citationCount: 2,
      wikilinkCount: 2,
      relationshipCount: 2,
      eventCount: 3,
      actorCount: 2
    })
    expect(buildMemoryGraph(pages, [], relationships)).toEqual(forward.graph)
    expect(buildMemoryAnalytics(pages, events)).toEqual(forward.analytics)
    expect(parseMemoryIndex(serializeMemoryIndex(forward.index))).toEqual(forward.index)
    expect(parseMemoryGraph(serializeMemoryGraph(forward.graph))).toEqual(forward.graph)
    expect(parseMemoryAnalytics(serializeMemoryAnalytics(forward.analytics))).toEqual(
      forward.analytics
    )
    expect(parseExportManifest(serializeExportManifest(forward.manifest))).toEqual(forward.manifest)
    expect(buildMemoryArtifacts(pages, [], events, relationships).manifest).toEqual(forward.manifest)
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
    const quote = "Jingler stores its durable state as files."
    const start = broken.body.indexOf(quote)
    const unsupported: MemoryRelationshipEvidence = {
      id: "evidence:broken",
      relationshipId: "relationship:broken",
      kind: "dependency",
      sourcePageId: broken.id,
      targetPageId: "missing-page",
      sourceRevisionId: "revision:broken",
      start,
      end: start + quote.length,
      quote,
      compilerEvidence: { sourceId: "architecture", start: 0, end: quote.length, quote },
      acceptedBy: "reviewer-01",
      acceptedAt: "2026-08-06T12:00:00.000Z"
    }
    expect(() => buildMemoryGraph([broken, notes!], [], [unsupported])).toThrow(/unresolved endpoints/)
    expect(buildBacklinkIndex([broken, notes!])).toEqual({
      "agent-notes": [],
      "project-overview": []
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
