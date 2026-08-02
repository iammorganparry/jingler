# Jingler Team Memory — tool catalog

> GENERATED FILE — do not edit by hand. Regenerate with
> `pnpm --filter @jingler/server skill:memory` after changing the MCP tools in
> apps/server/src/mcp-memory.ts. The "when to use" lines are hand-authored in
> apps/server/scripts/generate-memory-skill.ts.

Every tool the memory MCP server exposes, its arguments, and when to reach for it.
The server also returns these schemas at runtime (`tools/list`); this file is for
*choosing* the right tool. Tools are gated by privilege — a read-only token can call
the read tools but not the propose/review/schema tools.

## Retrieval (privilege: read)

### memory_dashboard
Read the pre-aggregated private team-memory dashboard.
- Args: `range` (optional, string).
- When to use: Gauge vault size/health/activity, not to answer a specific question.

### memory_graph
Read a bounded team-memory graph manifest without page bodies.
- Args: `limit` (optional, integer).
- When to use: Get a structural overview of how memory connects, then drill in with memory_graph_neighborhood.

### memory_graph_neighborhood
Expand one graph node by one hop without returning the complete graph.
- Args: `nodeId` (required, string, non-empty); `limit` (optional, integer).
- When to use: See what one specific page links to / is linked from, without pulling the whole graph.

### memory_edge_evidence
Read the exact accepted evidence for one explicit graph edge.
- Args: `edgeId` (required, string, non-empty).
- When to use: Verify WHY two pages are linked before trusting the relationship.

### memory_navigation
Read deterministic index and backlink navigation.
- Args: none.
- When to use: Browse structurally (index pages, backlinks) rather than by search.

### memory_export
Export accepted team-memory pages as an Obsidian-compatible vault.
- Args: none.
- When to use: Only when the user explicitly wants a full dump/backup — this is a heavy call.

### memory_read
Read one accepted page with stable page, revision, source, and citation ids.
- Args: `pageId` (required, string, non-empty).
- When to use: Load a page's full body before relying on it. Its revisionId is the baseRevisionId for updating that page via memory_propose.

### memory_search
Search accepted team-memory pages using private lexical search.
- Args: `query` (required, string, non-empty); `limit` (optional, integer).
- When to use: Start here for almost every question or task. Follow up with memory_read on the top hits.

### memory_suggestions
Read advisory 'related pages' relatedness suggestions. These are hints only, never accepted graph edges.
- Args: `limit` (optional, integer).
- When to use: Broaden context around a topic after an initial search. Advisory hints, not graph edges.

### memory_workflow_status
Poll a proposal or publication workflow by its explicit handle.
- Args: `workflowId` (required, string, non-empty).
- When to use: After proposing, poll the returned handle to see whether it published or is awaiting review.

## Contribution (privilege: propose)

### memory_propose
Create an explicit revision proposal and return its workflow handle.
- Args: `pageId` (required, string, non-empty); `baseRevisionId` (required, string, non-empty); `markdown` (required, string, non-empty).
- When to use: Publish anything worth remembering (any domain). baseRevisionId is 'new' for a new page, or a memory_read revisionId to update one. Idempotent by identity+content.

## Maintainer / review (privilege: review)

### memory_reviews
List bounded proposal sets for the private review inbox.
- Args: `limit` (optional, integer).
- When to use: Only when the org enabled the human review gate — list proposals awaiting a maintainer.

### memory_review
Approve or reject an explicit proposal handle.
- Args: `proposalId` (required, string, non-empty); `action` (required, "approve" | "reject").
- When to use: Approve or reject a pending proposal (maintainer).

## Schema (privilege: schema)

### memory_schema_publish
Publish a schema-governed accepted page.
- Args: `revisionId` (required, string, non-empty); `markdown` (required, string, non-empty).
- When to use: Advanced/maintainer path; most agents use memory_propose instead.
