# Shared team memory operations

Shared Memory is an opt-in paid-team feature that turns settled agent sessions
and other sources into a cited, review-gated Markdown wiki. The desktop talks to
the public Next.js endpoint; only Next.js can reach the private Cloudflare vault.

```text
Claude / Codex / OpenCode + Memory UI
                 |
                 | short-lived organization grant
                 v
       Next.js POST /api/mcp
                 |
                 | rotating service credential + organization scope
                 v
 Cloudflare Worker -> organization Durable Object -> R2 immutable records
                 |         |             |
                 |         |             +-> FTS5 / graph / analytics projections
                 |         +-> turbopuffer namespace (advisory relatedness only)
                 +-> Workflows (compiler / lint)
```

R2 accepted Markdown is the single recovery source of truth. Every other store —
the Durable Object's SQLite/FTS5, the graph, analytics, and the turbopuffer
vector namespace — is a rebuildable projection. The turbopuffer layer is
**advisory only**: it powers the inspector's "related pages" suggestions and is
never consulted by lexical search, the reproducible graph, or any export hash.
Absent a turbopuffer key, suggestions degrade to deterministic lexical
relatedness.

## Rollout

1. Deploy the Worker bindings and migrations from
   `apps/memory-worker/wrangler.jsonc`; verify `GET /health` reports every
   required binding.
2. Set the Next.js variables below and deploy `apps/server`.
3. Verify `GET /api/memory/health` returns `status: ok`.
4. Keep `MEMORY_ENABLED=false` during smoke tests. Enable it for paid-team
   organizations only after membership/billing metadata is current. Grant
   issuance still independently requires an active paid plan and membership.
5. Enable Memory in a test desktop workspace, submit a settled session, review
   the resulting proposal, retrieve it in a second session, and confirm a second
   organization cannot find its stable page/source/revision IDs.

`MEMORY_ENABLED=false` is the circuit breaker. It disables grants, MCP, and
capture at Next.js; agent execution fails open and R2/accepted Markdown are not
changed. Desktop workspaces also retain their own `memory.enabled` capture
preference.

## Cloudflare Worker configuration

`apps/memory-worker/wrangler.jsonc` is the deploy contract. Bindings:

| Binding | Kind | Config | Purpose |
| --- | --- | --- | --- |
| `MEMORY_VAULTS` | Durable Object | class `TeamVaultObject`, `new_sqlite_classes` migration `v1` | One SQLite DO per organization: heads, proposals, reviews, FTS5, events, projections. |
| `MEMORY_R2` | R2 bucket | `jingler-memory` | Immutable sources, accepted Markdown revisions, publication commits — the recovery source of truth. |
| `MEMORY_COMPILER` | Workflow | class `MemoryCompilerWorkflow` | Cited source-to-proposal compilation + durable review wait. |
| `MEMORY_LINT` | Workflow | class `MemoryLintWorkflow` | Scheduled vault-health reporting. |
| cron | Trigger | `17 3 * * *` | Daily lint for `MEMORY_LINT_ORGANIZATIONS` only. |

Worker secrets — set with `wrangler secret put`, never in `wrangler.jsonc`:

| Secret | Purpose |
| --- | --- |
| `MEMORY_SERVICE_SECRET` | Current Next.js-to-Worker credential; must equal Next.js `MEMORY_WORKER_SERVICE_SECRET`. |
| `MEMORY_SERVICE_SECRET_PREVIOUS` | Optional overlap slot during rotation. |
| `TURBOPUFFER_API_KEY` | Advisory vector layer. Absent ⇒ lexical-only suggestions. Read only in the Worker; never forwarded to Next.js or the renderer. |
| `OPENAI_API_KEY` | Client-side embeddings for the vector layer. Absent ⇒ lexical-only suggestions (the layer needs BOTH this and `TURBOPUFFER_API_KEY`). Read only in the Worker; never forwarded to Next.js or the renderer. |

Worker non-secret vars (committed in `wrangler.jsonc` `vars`):

| Var | Value | Purpose |
| --- | --- | --- |
| `TURBOPUFFER_BASE_URL` | `https://api.turbopuffer.com` | turbopuffer API origin. |
| `OPENAI_EMBED_MODEL` | `text-embedding-3-small` | Client-side embedding model; emits 1536-dim vectors stored as explicit vectors in turbopuffer. |

```bash
wrangler secret put MEMORY_SERVICE_SECRET   --config apps/memory-worker/wrangler.jsonc
wrangler secret put TURBOPUFFER_API_KEY     --config apps/memory-worker/wrangler.jsonc
wrangler secret put OPENAI_API_KEY          --config apps/memory-worker/wrangler.jsonc
wrangler deploy                             --config apps/memory-worker/wrangler.jsonc
curl -fsS "$MEMORY_WORKER_URL/health"       # reports binding presence only
```

> **Embeddings are client-side; turbopuffer stores explicit vectors.**
> turbopuffer's native/managed embedding is gated off on this account (live API
> returns 400 "embedding is not supported without help from tpuf"), so the Worker
> computes embeddings itself with OpenAI (`POST /v1/embeddings`) and upserts the
> precomputed vector: `POST /v2/namespaces/{ns}` with `distance_metric:
> cosine_distance` and `upsert_rows` carrying an explicit `vector` (never `text`,
> never `schema.embed`); query ranks with `rank_by: ["vector", "ANN",
> [...queryVector]]`. Both request shapes were validated live (200). The bounded
> snippet is embedded locally and never sent to turbopuffer. Because the layer is
> advisory and rebuildable, any OpenAI or turbopuffer failure degrades
> suggestions to lexical only — it never blocks memory or returns a 500.

## Next.js configuration

| Variable | Contract |
| --- | --- |
| `MEMORY_ENABLED` | Global rollout/circuit-breaker (`true` or `1` enables). |
| `MEMORY_GRANT_SECRET` | Dedicated HMAC secret for short-lived desktop grants. |
| `MEMORY_GRANT_AUDIENCE` | Must match grant verification; default `jingler-memory-mcp`. |
| `MEMORY_GRANT_TTL_SECONDS` | Short desktop-UI grant lifetime; default `300`. |
| `MEMORY_ATTACHMENT_GRANT_TTL_SECONDS` | Longer lifetime for the agent MCP attachment grant; default `3600`. Interim until the main-process proxy mints per-request grants. |
| `MEMORY_GRANT_AUDIENCE` | Grant audience claim; default `jingler-memory-mcp`. Must match Worker verification. |
| `MEMORY_WORKER_URL` | Private Worker origin. |
| `MEMORY_WORKER_SERVICE_SECRET` | Current Next.js-to-Worker credential. Must equal the Worker's `MEMORY_SERVICE_SECRET`. |
| `MEMORY_REQUEST_TIMEOUT_MS` | Bounded upstream request timeout; default `5000`. |

Vercel project root is `apps/server`; runtime is Node/standalone. Configure all
variables separately in Preview and Production. Never expose either Memory
secret with a `NEXT_PUBLIC_` prefix. The Jingler bearer stays in the desktop
main-process secret store; the short-lived Memory grant never crosses Electron
IPC or enters renderer diagnostics.

**The paid-org gate is independent of `MEMORY_ENABLED`.** Even with the feature
globally enabled, `POST /api/memory/grant` issues a grant only for an
organization the caller belongs to that has an active paid plan; every other
organization gets `403`. `MEMORY_ENABLED=false` is the global breaker on top of
that per-organization check.

## MCP compatibility

The only supported version is `2026-07-28`. Each operation is an independent
HTTP POST to `/api/mcp` with:

- `Authorization: Bearer <short-lived-memory-grant>`
- `MCP-Protocol-Version: 2026-07-28`
- `X-Jingler-Organization-Id: <exact-grant-organization>`
- matching `MCP-Method` and, for calls, `MCP-Name`
- `_meta` containing protocol version, client info, and capabilities

Clients call `server/discover`, `tools/list`, or `tools/call` independently.
There is no `initialize`, GET transport, SSE resume, `Mcp-Session-Id`, cookie,
connection state, or instance affinity. Long-running compilation uses explicit
workflow/proposal handles and polling, so any Next.js instance can serve the
next request. Every result includes `resultType` and server metadata; cacheable
lists are private and carry a bounded TTL.

## Monitoring and alerts

Monitor both `GET /api/memory/health` and the Worker `GET /health`. Alert on:

- 5xx/timeout rate and p95 latency between Next.js and the Worker;
- grant 401/403 changes, separated from feature-disabled 503 responses;
- Durable Object conflicts or stale proposal outcomes;
- Workflow queued/running age and failed compiler/lint runs;
- R2 write failures or immutable-object collisions;
- zero-result ratio, citation coverage, freshness, orphan/broken-link counts,
  contradictions, and median review age.

Logs may include request IDs, organization-scoped aggregate counts, status, and
duration. They must not include bearer/grant/service credentials, query text,
page bodies, source content, transcripts, or `Mcp-Session-Id`.

## Export, rebuild, and recovery

The immutable R2 prefix is the vault export:

```text
organizations/<url-encoded-organization-id>/
  sources/blobs/<sha256>
  sources/records/<sha256>.json
  pages/blobs/<sha256>.md
  revisions/<sha256>.json
  publications/<publication-id>.json
```

Use Cloudflare's R2 S3-compatible API or managed export to copy that exact
prefix to encrypted storage. Do not export another organization's prefix in the
same operator artifact. Hash the object inventory and retain the generated
manifest with the backup.

To rebuild projections after SQLite loss or suspected drift:

```bash
curl -fsS -X POST "$MEMORY_WORKER_URL/internal/memory/rebuild" \
  -H "Authorization: Bearer $MEMORY_WORKER_SERVICE_SECRET" \
  -H "X-Jingler-Organization-Id: $ORGANIZATION_ID"
```

The rebuild validates accepted Markdown and reconstructs heads, FTS5, index,
backlinks, graph, and analytics. Only revisions referenced by completed
multi-page publication commits are accepted. Compare rebuilt counts and derived
fingerprints, exercise lexical search and one-hop expansion, then re-enable
traffic. Never repair factual Markdown in place; restore immutable objects or
publish a reviewed revision.

The turbopuffer namespace is a separate, advisory projection with no dedicated
rebuild endpoint — it self-heals. Every `memory_suggestions` request reconciles
one organization's namespace against its R2-backed accepted pages: new and
content-changed pages are re-embedded (content-hash keyed, so unchanged pages
are skipped) and removed pages are deleted. To force a clean re-embed, delete the
organization's namespace directly through turbopuffer (namespace
`jingler-memory--<url-encoded-organization-id>`); the next suggestions request
rebuilds it from R2.

Losing the vector namespace never affects accepted memory: lexical search, the
graph, analytics, and exports are computed without it, and suggestions fall back
to deterministic lexical relatedness until the namespace is repopulated. The
namespace holds only an explicit embedding vector and flat retrieval attributes —
never a full page body or even the snippet — so it is not part of the vault
export.

## Credential rotation and incident recovery

1. Generate unrelated high-entropy grant and service secrets.
2. Put the old Worker credential in `MEMORY_SERVICE_SECRET_PREVIOUS` and deploy.
3. replace `MEMORY_WORKER_SERVICE_SECRET` in Next.js and deploy.
4. Confirm health and a scoped read, remove the previous Worker credential, and
   deploy again.
5. Rotate `MEMORY_GRANT_SECRET` separately. Existing grants expire within their
   TTL; desktop requests obtain new grants without session state.
6. Rotate `TURBOPUFFER_API_KEY` independently with `wrangler secret put
   TURBOPUFFER_API_KEY` and redeploy the Worker. It has no overlap slot and needs
   none: the key rides only the Worker's outbound turbopuffer calls, so a rotation
   takes effect on the next suggestions request. If the key is cleared entirely,
   suggestions degrade to lexical only until a new key is set.

For suspected disclosure, first set `MEMORY_ENABLED=false`, rotate both secrets
(and the turbopuffer key if it may be affected), inspect request IDs and
immutable-object audit events, rebuild/verify affected organizations, then
re-enable. Disabling capture or rotating credentials never deletes accepted
Markdown. To stop capture without a full disable, operators clear
`MEMORY_ENABLED` (global) or a workspace's own `memory.enabled` preference; either
halts new sources while leaving accepted Markdown and all reads intact.

## Verification commands

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm --filter @jingler/server test
pnpm --filter @jingler/server test:integration  # needs migrated local Postgres
pnpm --filter @jingler/memory-worker test
pnpm --filter @jingler/desktop exec playwright test \
  shared-memory memory-map memory_electron memory-suggestions
```

The memory e2e specs are Playwright `_electron`, local-only (not in CI), against
a deterministic in-process fake — no real Cloudflare, turbopuffer, or Postgres.
Coverage: teammate retrieval isolated per organization; review gating (stale
conflict, secret rejection, paid-team enforcement, fail-open outage); stateless
MCP (independent POSTs, no session ids, alternating instances); sidebar →
dashboard → map → page navigation with the time-range drilldown, edge evidence,
viewport restore, and reduced-motion; and advisory suggestions rendered
non-authoritatively with promotion routed through the cited-wikilink page flow.

Electron e2e uses one deterministic stateful fake across app instances. It
records protocol metadata but never bearer values, alternates simulated Next.js
instances, publishes only after review, and keeps organization vaults separate.
