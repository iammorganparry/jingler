# Retired Memory infrastructure teardown

Use this only after deploying the application version that removes Memory. Cloud deletion is manual and irreversible.

## 1. Stop traffic

- Deploy the updated Next.js server and desktop release.
- Confirm `/api/memory/*` and `/api/mcp` return `404`.
- Confirm the Worker receives no requests for one normal grant-TTL window (previously 60 minutes).

## 2. Remove configuration

Remove these variables from every Vercel environment (Production, Preview, and Development):

```text
MEMORY_ENABLED
MEMORY_GRANT_SECRET
MEMORY_GRANT_AUDIENCE
MEMORY_GRANT_TTL_SECONDS
MEMORY_WORKER_URL
MEMORY_WORKER_SERVICE_SECRET
MEMORY_REQUEST_TIMEOUT_MS
```

Remove these Cloudflare Worker secrets:

```text
MEMORY_SERVICE_SECRET
MEMORY_SERVICE_SECRET_PREVIOUS
MEMORY_WORKFLOW_ID_SECRET
TURBOPUFFER_API_KEY
OPENAI_API_KEY
```

Vercel CLI reference: https://vercel.com/docs/cli/env

## 3. Preserve data if required

Before deletion, export the `jingler-memory` R2 bucket or copy each required organization prefix to encrypted storage. Record the object count and inventory hash. Confirm retention, legal, and customer-data requirements before continuing.

Cloudflare R2 deletion guide: https://developers.cloudflare.com/r2/buckets/delete-buckets/

## 4. Delete cloud resources

> **Destructive:** do not run this section until the export decision is recorded.

1. Empty and delete the `jingler-memory` R2 bucket.
2. Delete the deployed Memory Worker and its routes/custom domain.
3. Delete the Workflows previously bound as `MEMORY_COMPILER` and `MEMORY_LINT` if they remain after Worker deletion.
4. Delete the `MEMORY_VAULTS` Durable Object namespace and stored instances if they remain after Worker deletion.
5. Delete the turbopuffer namespaces prefixed `jingler-memory--`.

Use the current Cloudflare dashboard or Wrangler command reference rather than copying stale command syntax: https://developers.cloudflare.com/workers/wrangler/commands/workers/

## 5. Verify

- Cloudflare lists no Memory Worker, routes, Workflows, Durable Object namespace, or R2 bucket.
- Vercel lists none of the variables above in any environment.
- DNS has no Memory Worker hostname.
- Billing shows no continuing R2, Durable Object, Workflow, OpenAI embedding, or turbopuffer usage after the provider reporting delay.
- A clean database migration applies `apps/server/drizzle/0011_yellow_tenebrous.sql` and no `personal_access_token` table remains.
