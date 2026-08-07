# `@jingler/github-relay`

Cloudflare Worker that verifies GitHub App webhooks and streams normalized PR
events to authenticated Jingler desktops. Event streams are SQLite-backed
Durable Objects, so a disconnected desktop can resume from its last acknowledged
cursor.

The production relay base URL is `https://github-relay.jingler.dev`. The auth
server that mints relay grants and installation credentials is
`https://api.jingler.dev`.

## Public endpoints

- `GET /health` — liveness/readiness without secret values.
- `POST /webhooks/github` — the **only** GitHub webhook endpoint. It requires
  `X-Hub-Signature-256`, `X-GitHub-Delivery`, and `X-GitHub-Event`.
- `GET /events?clientId=<stable-device-id>&cursor=<last-local-cursor>` — WebSocket
  upgrade using a session-scoped `Authorization: Bearer
  <short-lived-server-grant>`.
- `POST /internal/session-routes` — server-only, timestamped HMAC-authenticated
  registration of one `(installationId, repositoryId, pullRequestNumber)` to
  an opaque `relaySessionId`, with `active`, `archived`, or `removed` state and
  a monotonic generation that prevents delayed Workflows resurrecting stale
  routes.
- `POST /internal/installations` — server-only, timestamped
  HMAC-authenticated desired state (`active`, `suspended`, or `removed`) for one
  durable `(userId, installationId)` ownership record.
- `POST /internal/revoke` — compatibility alias for a `removed` installation
  mutation.

The webhook body is capped at 2 MiB and its HMAC is verified over the exact raw
bytes before JSON parsing. GitHub delivery IDs and content-derived semantic keys
deduplicate retries and unchanged comment edits.

The relay persists only actionable human review/comment feedback. PR state and
CI/check data are fetched by the PR screen and must not be subscribed as relay
webhooks; doing both duplicates traffic without improving freshness.

## Routing and retention

GitHub sends installation, repository, and pull-request identity rather than a
Jingler session ID. The server registers that tuple in one
`InstallationRoutesObject` per installation through its durable database
outbox. The route resolves to an opaque server-issued `relaySessionId`.

Every linked Jingler session has a distinct `SessionEventsObject` named by that
opaque ID. The object owns the session's event log, deduplication, client
acknowledgements, replay cursor, and hibernating sockets. Two sessions owned by
the same user — including two PRs in one repository — never share storage or a
cursor stream. The desktop routes an event using its connection context and
does not guess the session from PR metadata.

Socket grants do not create, extend, or delete ownership. They only prove that
one desktop may open a socket for an already active session route. Grant expiry
closes that socket; it does not erase the route or the session's replay log.
Reconciliation and verified `installation` lifecycle webhooks independently
activate, suspend, or remove durable routes.

Registration and delivery Workflows are idempotent and retry transient steps.
If delivery arrives before its session route, route resolution retries; a
terminal registration-lag failure releases admission so a GitHub redelivery can
start a deterministic retry attempt. The route is revalidated while the
installation object serializes the final session append, preventing an archive,
unlink, or transfer from racing a stale Workflow checkpoint.

- Event and delivery-deduplication retention: 7 days.
- Maximum stored events per session: 5,000.
- Replay page: 500 events. A `replay-more` frame supplies the cursor for the
  next `resume` request.
- Client acknowledgements are persisted by stable `clientId`; reconnecting with
  a stale local cursor resumes from the greater persisted cursor.

The Durable Object stores each socket's grant expiry in its hibernation
attachment and closes the socket at that timestamp. Reconnection reuses the
cached session grant until its one-hour expiry. Explicit disconnect commits local authorization deletion
and an idempotent `removed` outbox mutation before the relay call is attempted.
Reconciled session changes affect only the matching opaque session route;
verified GitHub installation `suspend` and `deleted` webhooks affect every
session registered under that installation.

Server frames are JSON:

```json
{ "type": "hello", "cursor": 12, "newestCursor": 14 }
{ "type": "event", "cursor": 13, "event": {} }
{ "type": "replay-more", "cursor": 512 }
```

Client data frames are `ack` or `resume`; liveness uses WebSocket protocol
ping/pong so Cloudflare can respond without waking a hibernating Durable Object.
The JSON `ping` frame remains accepted for older desktop versions.

```json
{ "type": "ack", "cursor": 13 }
{ "type": "resume", "cursor": 512 }
```

## Local development

Copy `.dev.vars.example` to `.dev.vars` and use the same values as the
development GitHub App and server:

```sh
pnpm --filter @jingler/github-relay dev
cloudflared tunnel --url http://localhost:9200
```

Set the development GitHub App webhook URL to:

```text
https://<cloudflared-host>/webhooks/github
```

Choose `application/json` and enter the same webhook secret as
`GITHUB_WEBHOOK_SECRET`. The desktop does not launch or depend on cloudflared;
the tunnel is only for local webhook development.

### Development App smoke test

Use a dedicated development App and disposable repository. This is a manual
release smoke because GitHub installation consent and App webhook configuration
are external account mutations; the hermetic Electron suite covers the same
state transitions without touching a developer account.

1. Start Postgres, apply migrations `0003_github_app.sql` and
   `0004_github_relay_hardening.sql`, then start the server, relay, desktop, and
   `cloudflared` as above. Supply a dedicated
   `GITHUB_APP_TOKEN_ENCRYPTION_KEY`; do not derive it from either relay secret.
2. Put the cloudflared `/webhooks/github` URL in the development App, select the
   documented permissions/subscriptions, and install it on only the disposable
   repository. Complete **Settings → GitHub → Install / Connect GitHub**.
3. Create a fresh worktree session. Confirm it starts detached at the refreshed
   base, then becomes a validated `type/kebab-slug` branch after the first task
   turn. Confirm no `jingler/*` ref is created.
4. Change a file, publish, and confirm the explicit HTTPS push, one Conventional
   Commit, one PR, and the linked PR number. Review and merge it from Jingler.
5. Post a human review comment with file/line context. Confirm GitHub Recent
   Deliveries reports `2xx` and exactly one visible instruction appears in the
   linked session.
6. Disconnect the desktop for longer than a relay grant lifetime, post another
   review comment, reconnect, and confirm it replays once. Restart again and
   confirm the acknowledged event is not routed twice.
7. Uninstall the App. Refresh Settings and confirm access becomes unavailable,
   sockets close, and a redelivery has zero active routes. Restore the App's
   prior webhook URL only if the development App is shared.

Record the App slug, disposable repository, branch, PR, GitHub delivery IDs,
relay deployment version, and pass/fail result in the release evidence. Never
record tokens, webhook bodies, authorization headers, or feedback text.

## Deployment

Generate binding types and validate the bundle:

```sh
pnpm --filter @jingler/github-relay types
pnpm --filter @jingler/github-relay deploy:dry
```

Configure secrets separately for each environment:

```sh
pnpm --filter @jingler/github-relay exec wrangler secret put GITHUB_WEBHOOK_SECRET
pnpm --filter @jingler/github-relay exec wrangler secret put GITHUB_RELAY_SIGNING_SECRET
```

`GITHUB_RELAY_SIGNING_SECRET` must match the auth server's
`GITHUB_APP_RELAY_SIGNING_SECRET`. Rotate it by deploying the Worker secret and
server secret together; outstanding short-lived grants will stop reconnecting
and will be refreshed by the desktop. This rotation does not change the
server's independent GitHub OAuth-token encryption keys. Rotate the GitHub webhook secret by
updating the GitHub App and Worker together, then verify deliveries in GitHub's
Recent Deliveries page.

Deploy with `wrangler deploy`. A rollback may restore the previous Worker
version without changing Durable Object storage. The `v2` migration renames
`UserEventsObject` to `SessionEventsObject`; it preserves existing SQLite
storage while all new event streams are addressed by opaque session ids.

The committed Wrangler route publishes the Worker as the Cloudflare custom
domain `github-relay.jingler.dev`; custom domains do not require an account- or
zone-specific ID in this file. Configure the production GitHub App with:

- Callback URL: `https://api.jingler.dev/api/github/callback`
- Setup URL: `https://api.jingler.dev/api/github/setup`
- Webhook URL: `https://github-relay.jingler.dev/webhooks/github`

The App should subscribe only to Installation, Issue comment, Pull request
review, and Pull request review comment events. Repository permissions are
documented in the [server registration guide](../server/README.md#github-app-registration).

## Operations and recovery

Cloudflare observability is enabled in `wrangler.jsonc`. Monitor at least:

- `invalid_signature` by `source`, rejected oversized bodies, and delivery IDs
  that repeatedly fail before acknowledgement;
- `routing_count`, `zero_route_delivery`, and
  `delivery_deduplicated` without logging the normalized event body;
- `replay_depth` and its `rowsRead` value by cursor only;
- `installation_registration`, `installation_lifecycle`,
  `revocation_completed`, and server outbox retry age;
- `ignored_event`, `retention_compaction`, `sql_retention`, and events dropped at the retention
  boundary;
- Durable Object exceptions, storage growth, and alarm/compaction failures.

All relay telemetry is structured metadata. Credentials, authorization headers,
raw webhook bytes, normalized feedback bodies, and comment text are forbidden in
logs. A zero-route delivery is actionable: verify the server outbox and the
installation's active owners before redelivering it.

GitHub's **Recent deliveries** page is the source for webhook request status and
safe redelivery. `X-GitHub-Delivery` is the relay idempotency key, so redelivering
the same request does not create another stored event or agent instruction.
Desktops resume from the greater of their local and persisted acknowledged
cursors. Do not delete Durable Object storage to repair a client: reconnect it
with its last acknowledged cursor and allow bounded replay to complete.

If server-to-relay registration fails, leave the outbox row in place and repair
connectivity or signing-secret skew. A later authenticated GitHub status,
refresh, callback, grant, or disconnect request retries due rows with bounded
backoff. Do not mint a long-lived socket grant as a routing workaround.

If delivery must be stopped during an incident, disable the webhook in the
GitHub App before changing storage. Preserve the Worker and Durable Object data,
deploy the last known-good Worker version, restore matching current secrets,
then redeliver failed GitHub deliveries. A code rollback does not roll back or
erase SQLite state. Schema changes after `v2` must remain forward-compatible
with the rollback version or ship with an explicit recovery tool.

## Verification

```sh
pnpm --filter @jingler/github-relay typecheck
pnpm --filter @jingler/github-relay test
pnpm --filter @jingler/github-relay deploy:dry
```
