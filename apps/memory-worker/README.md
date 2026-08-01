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
| `MEMORY_COMPILER` | Workflow | Cited source-to-proposal compilation and durable review wait. |
| `MEMORY_LINT` | Workflow | Scheduled vault health reporting. |

The daily `17 3 * * *` trigger starts lint only for the comma-separated
`MEMORY_LINT_ORGANIZATIONS`. `MEMORY_AUTO_PUBLISH_FIXES` is also comma-separated;
leave it empty unless a reviewed mechanical fix identifier is explicitly safe
to auto-publish.

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

Set the current credential in `MEMORY_SERVICE_SECRET` and the old credential in
`MEMORY_SERVICE_SECRET_PREVIOUS`, deploy the Worker, update
`MEMORY_WORKER_SERVICE_SECRET` in Next.js, then remove the previous value and
deploy again. Both credentials use constant-work comparison. Never reuse
`MEMORY_GRANT_SECRET` as the service credential.

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

Do not delete or rewrite R2 objects during rebuild. If a projection is suspect,
disable hosted access with Next.js `MEMORY_ENABLED=false`, export the prefix,
rebuild, verify, and re-enable. Accepted Markdown remains available throughout.
