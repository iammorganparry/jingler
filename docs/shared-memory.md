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
                 |                 |
                 +-> Workflows     +-> FTS5 / graph / analytics projections
```

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

## Next.js configuration

| Variable | Contract |
| --- | --- |
| `MEMORY_ENABLED` | Global rollout/circuit-breaker (`true` or `1` enables). |
| `MEMORY_GRANT_SECRET` | Dedicated HMAC secret for short-lived desktop grants. |
| `MEMORY_GRANT_AUDIENCE` | Must match grant verification; default `jingler-memory-mcp`. |
| `MEMORY_GRANT_TTL_SECONDS` | Short grant lifetime; production default target is 300 seconds. |
| `MEMORY_WORKER_URL` | Private Worker origin. |
| `MEMORY_WORKER_SERVICE_SECRET` | Current Next.js-to-Worker credential. |
| `MEMORY_REQUEST_TIMEOUT_MS` | Bounded upstream request timeout. |

Vercel project root is `apps/server`; runtime is Node/standalone. Configure all
variables separately in Preview and Production. Never expose either Memory
secret with a `NEXT_PUBLIC_` prefix. The Jingler bearer stays in the desktop
main-process secret store; the short-lived Memory grant never crosses Electron
IPC or enters renderer diagnostics.

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

## Credential rotation and incident recovery

1. Generate unrelated high-entropy grant and service secrets.
2. Put the old Worker credential in `MEMORY_SERVICE_SECRET_PREVIOUS` and deploy.
3. replace `MEMORY_WORKER_SERVICE_SECRET` in Next.js and deploy.
4. Confirm health and a scoped read, remove the previous Worker credential, and
   deploy again.
5. Rotate `MEMORY_GRANT_SECRET` separately. Existing grants expire within their
   TTL; desktop requests obtain new grants without session state.

For suspected disclosure, first set `MEMORY_ENABLED=false`, rotate both secrets,
inspect request IDs and immutable-object audit events, rebuild/verify affected
organizations, then re-enable. Disabling capture or rotating credentials never
deletes accepted Markdown.

## Verification commands

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm --filter @jingler/server test
pnpm --filter @jingler/server test:integration  # needs migrated local Postgres
pnpm --filter @jingler/memory-worker test
pnpm --filter @jingler/desktop e2e -- shared-memory.spec.ts memory-map.spec.ts
```

Electron e2e uses one deterministic stateful fake across app instances. It
records protocol metadata but never bearer values, alternates simulated Next.js
instances, publishes only after review, and keeps organization vaults separate.
