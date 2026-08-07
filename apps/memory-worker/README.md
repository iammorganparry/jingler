# Jingler memory Worker

The private Cloudflare service stores one organization per SQLite Durable
Object and immutable, content-addressed source/page objects in an
organization-prefixed R2 bucket. SQLite/FTS5, navigation, graph, and analytics
are rebuildable projections; R2 accepted Markdown is the recovery source of
truth.

The public desktop never calls this Worker. Next.js is the only caller and must
send both a rotating service credential and `X-Jingler-Organization-Id`.

## Bindings

`wrangler.jsonc` declares the production contract:

| Binding | Kind | Purpose |
| --- | --- | --- |
| `MEMORY_VAULTS` | SQLite Durable Object | Serialized heads, proposals, reviews, FTS5, events, and derived projections for one organization. |
| `MEMORY_R2` | R2 | Immutable sources, accepted Markdown revisions, and publication commit records. |
| `MEMORY_COMPILER` | Workflow | class `MemoryCompilerWorkflow` — cited source-to-proposal compilation and automatic publication. |
| `MEMORY_LINT` | Workflow | class `MemoryLintWorkflow` — scheduled vault health reporting. |

`MEMORY_VAULTS` is class `TeamVaultObject` (SQLite DO, `new_sqlite_classes`
migration `v1`); `MEMORY_R2` is bucket `jingler-memory`; the cron is `17 3 * * *`.

The daily `17 3 * * *` trigger starts lint only for the comma-separated
`MEMORY_LINT_ORGANIZATIONS`. `MEMORY_AUTO_PUBLISH_FIXES` is also comma-separated;
leave it empty unless a reviewed mechanical fix identifier is explicitly safe
to auto-publish.

## Automatic publication migration

Agent-authored memories publish automatically after the agent applies the
durability, sensitivity, and deduplication policy. The former
`MEMORY_REQUIRE_REVIEW` deployment gate is retired and ignored; remove it from
Worker configuration. While it remains set, the Worker logs a deprecation
warning and reports that warning from `/health`, but it does not restore a
manual queue. Historical proposal/review endpoints remain available only for
audit and recovery.

## Secrets and vars

Secrets via `wrangler secret put` (never in `wrangler.jsonc`):

| Secret | Purpose |
| --- | --- |
| `MEMORY_SERVICE_SECRET` | Current Next.js-to-Worker credential; must equal Next.js `MEMORY_WORKER_SERVICE_SECRET`. |
| `MEMORY_SERVICE_SECRET_PREVIOUS` | Optional overlap slot during rotation. |
| `MEMORY_WORKFLOW_ID_SECRET` | Stable workflow-id HMAC key. Set once; do not rotate with the service credential. |
| `TURBOPUFFER_API_KEY` | Advisory vector layer. Absent ⇒ lexical-only suggestions. Read only here; never forwarded to Next.js or the renderer. |
| `OPENAI_API_KEY` | Client-side embeddings. Absent ⇒ lexical-only suggestions (the vector layer needs BOTH this and `TURBOPUFFER_API_KEY`). Read only here; never forwarded to Next.js or the renderer. |

Non-secret `vars` (committed in `wrangler.jsonc`):

| Var | Value |
| --- | --- |
| `TURBOPUFFER_BASE_URL` | `https://api.turbopuffer.com` |
| `OPENAI_EMBED_MODEL` | `text-embedding-3-small` (client-side embedding, 1536-dim) |

## Advisory vector layer (turbopuffer)

The vector layer is an advisory sidecar: one turbopuffer namespace per
organization (`jingler-memory--<url-encoded-org-id>`), holding only an explicit
embedding vector and flat attributes — never a page body. It is never consulted
by FTS5 search, the reproducible graph, or any export hash; its sole output is
scored relatedness for the inspector's "related pages" suggestions
(`GET /internal/memory/suggestions`, MCP tool `memory_suggestions`).

It uses **client-side embeddings with explicit vectors**: the Worker embeds a
bounded per-page snippet with OpenAI (`POST /v1/embeddings`,
`text-embedding-3-small`, 1536-dim), then upserts the precomputed vector to
`POST /v2/namespaces/{ns}` (`distance_metric: cosine_distance`, `upsert_rows`
with an explicit `vector` — no `text`, no `schema.embed`); query ranks with
`rank_by: ["vector", "ANN", [...queryVector]]`. The snippet is never sent to
turbopuffer. There is no dedicated rebuild route — every suggestions request
reconciles the namespace against R2-backed accepted pages (content-hash keyed:
only changed pages re-embed, removed pages are deleted). To force a clean
re-embed, delete the org's namespace directly in turbopuffer; the next
suggestions request repopulates it from R2.

> **Why explicit vectors.** turbopuffer's native/managed embedding is gated off
> on this account (live API returns 400 "embedding is not supported without help
> from tpuf"), so the Worker computes embeddings itself. The explicit-vector
> upsert and `rank_by: ["vector", "ANN", [...]]` query were validated live (both
> 200). The layer is advisory and rebuildable, and BOTH `OPENAI_API_KEY` and
> `TURBOPUFFER_API_KEY` must be present to activate it; any OpenAI or turbopuffer
> failure degrades suggestions to lexical-only and never blocks memory.

## Local and production configuration

Copy `.dev.vars.example` to `.dev.vars` for local Wrangler work. Never commit
`.dev.vars`.

```bash
pnpm dlx wrangler dev --config apps/memory-worker/wrangler.jsonc
curl http://127.0.0.1:8787/health
pnpm dlx wrangler deploy --config apps/memory-worker/wrangler.jsonc
```

The health response reports only binding presence. Vault routes remain private.
Run `pnpm --filter @jingler/memory-worker test` before deployment.

## Limits and definitions

- Graph lists default to 200 nodes and never exceed 500; a neighborhood defaults
  to 50 and never exceeds 100. At most 50 topic clusters and 10 samples per
  cluster are returned. Graph responses contain no page bodies.
- Every edge is backed by accepted wikilink, citation, dependency, backlink, or
  schema evidence. Embedding/inferred edges are not generated.
- Compiler inputs are capped at 32,000 characters, 12 claims, 12 candidate
  pages, and 3 generated pages. Proposal sets cap at 8 pages.
- Dashboard growth counts accepted revisions/pages by event time. Citation
  coverage is cited accepted pages divided by accepted pages. Freshness is
  derived from accepted timestamps. Review throughput uses proposal outcomes.
  Connectivity uses explicit accepted edges. Retrieval stores aggregate counts,
  hashed-query cardinality, result counts, and latency—not query text or bodies.

## Credential rotation

Set `MEMORY_WORKFLOW_ID_SECRET` to a dedicated random value before the first
service-secret rotation and keep it stable for the deployment's lifetime.
Set the current credential in `MEMORY_SERVICE_SECRET` and the old credential in
`MEMORY_SERVICE_SECRET_PREVIOUS`, deploy the Worker, update
`MEMORY_WORKER_SERVICE_SECRET` in Next.js, then remove the previous value and
deploy again. Both credentials use constant-work comparison. Never reuse
`MEMORY_GRANT_SECRET` as the service credential.

Rotate `TURBOPUFFER_API_KEY` independently (`wrangler secret put
TURBOPUFFER_API_KEY` + redeploy). It needs no overlap slot — it rides only the
Worker's outbound turbopuffer calls, so a new key takes effect on the next
suggestions request; clearing it degrades suggestions to lexical only.

## Rebuild and recovery

Rebuild one organization's complete SQLite/FTS5/search/navigation/graph/
analytics projection from committed R2 records:

```bash
curl -fsS -X POST "$MEMORY_WORKER_URL/internal/memory/rebuild" \
  -H "Authorization: Bearer $MEMORY_WORKER_SERVICE_SECRET" \
  -H "X-Jingler-Organization-Id: $ORGANIZATION_ID"
```

The result reports rebuilt page, revision, and source counts. A revision that
belongs to a multi-page publication is visible only when its immutable
`publications/<id>.json` commit includes that revision, so an interrupted
publication cannot become an accepted head during recovery.

For export or disaster recovery, copy only
`organizations/<url-encoded-organization-id>/` from R2. Preserve object keys and
metadata. The prefix contains source blobs/records, Markdown blobs, revision
records, and publication commits; it is sufficient to create an empty Durable
Object and run the rebuild above. Validate the restored page counts, then compare
navigation, graph, and dashboard fingerprints before redirecting traffic.

The advisory turbopuffer namespace is NOT part of this rebuild — it reconciles
itself from R2-backed accepted pages on the next suggestions request. Delete the
org's namespace in turbopuffer if you want a forced clean re-embed.

Do not delete or rewrite R2 objects during rebuild. If a projection is suspect,
disable hosted access with Next.js `MEMORY_ENABLED=false`, export the prefix,
rebuild, verify, and re-enable. Accepted Markdown remains available throughout.
