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
  upgrade using `Authorization: Bearer <short-lived-server-grant>`.
- `POST /internal/revoke` — server-only, timestamped HMAC-authenticated removal
  of one `(userId, installationId)` subscription and its active sockets.

The webhook body is capped at 2 MiB and its HMAC is verified over the exact raw
bytes before JSON parsing. GitHub delivery IDs and content-derived semantic keys
deduplicate retries and unchanged comment edits.

## Routing and retention

GitHub sends an installation ID, not a Jingler user ID. A verified relay grant
registers its `(installationId, userId)` subscription before the WebSocket is
opened. One installation may therefore fan out to multiple Jingler users;
subscriptions are stored as a set and cannot overwrite one another. Events then
enter one `UserEventsObject` per Jingler user, preserving cross-user isolation.

- Event retention: 7 days. Subscription retention is capped at 10 minutes and
  never outlives the relay grant that established it.
- Maximum stored events per user: 5,000.
- Maximum subscriptions per installation: 10,000.
- Replay page: 500 events. A `replay-more` frame supplies the cursor for the
  next `resume` request.
- Client acknowledgements are persisted by stable `clientId`; reconnecting with
  a stale local cursor resumes from the greater persisted cursor.

The Durable Object stores each socket's grant expiry in its hibernation
attachment and closes the socket at that timestamp. Reconnection always obtains
a fresh server grant. Explicit disconnect and reconciled uninstall/suspension
revoke only the matching user and installation; verified GitHub installation
`suspend` and `deleted` webhooks revoke every user subscribed to that installation.

Server frames are JSON:

```json
{ "type": "hello", "cursor": 12, "newestCursor": 14 }
{ "type": "event", "cursor": 13, "event": {} }
{ "type": "replay-more", "cursor": 512 }
```

Client frames are `ack`, `resume`, or `ping`:

```json
{ "type": "ack", "cursor": 13 }
{ "type": "resume", "cursor": 512 }
{ "type": "ping" }
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
server secret together; outstanding five-minute grants will stop reconnecting
and will be refreshed by the desktop. Rotate the GitHub webhook secret by
updating the GitHub App and Worker together, then verify deliveries in GitHub's
Recent Deliveries page.

Deploy with `wrangler deploy`. A rollback may restore the previous Worker
version without changing Durable Object storage; the `v1` SQLite migration is
additive.

The committed Wrangler route publishes the Worker as the Cloudflare custom
domain `github-relay.jingler.dev`; custom domains do not require an account- or
zone-specific ID in this file. Configure the production GitHub App with:

- Callback URL: `https://api.jingler.dev/api/github/callback`
- Setup URL: `https://api.jingler.dev/api/github/setup`
- Webhook URL: `https://github-relay.jingler.dev/webhooks/github`

The App should subscribe only to Check run, Check suite, Installation,
Installation repositories, Issue comment, Pull request, Pull request review,
Pull request review comment, and Status events. Repository permissions are
documented in the [server registration guide](../server/README.md#github-app-registration).

## Operations and recovery

Cloudflare observability is enabled in `wrangler.jsonc`. Monitor at least:

- webhook signature failures, rejected oversized bodies, and delivery IDs that
  repeatedly fail before acknowledgement;
- webhook-to-WebSocket delivery lag and the age of the oldest retained event;
- WebSocket connects, reconnect frequency, replay depth, acknowledgements, and
  events dropped at the retention boundary;
- ignored bot events and events with no active installation
  subscription;
- Durable Object exceptions, storage growth, and alarm/compaction failures.

GitHub's **Recent deliveries** page is the source for webhook request status and
safe redelivery. `X-GitHub-Delivery` is the relay idempotency key, so redelivering
the same request does not create another stored event or agent instruction.
Desktops resume from the greater of their local and persisted acknowledged
cursors. Do not delete Durable Object storage to repair a client: reconnect it
with its last acknowledged cursor and allow bounded replay to complete.

If delivery must be stopped during an incident, disable the webhook in the
GitHub App before changing storage. Preserve the Worker and Durable Object data,
deploy the last known-good Worker version, restore matching current secrets,
then redeliver failed GitHub deliveries. A code rollback does not roll back or
erase SQLite state. Schema changes after `v1` must remain forward-compatible
with the rollback version or ship with an explicit recovery tool.

## Verification

```sh
pnpm --filter @jingler/github-relay typecheck
pnpm --filter @jingler/github-relay test
pnpm --filter @jingler/github-relay deploy:dry
```
