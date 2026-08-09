# @jingler/device-relay

Cloudflare Worker control plane for account-owned environments. A
`DeviceRegistryObject` owns one user's device identities, enrollment claims,
presence, discovery, generations, and revocation. A `SessionTunnelObject` owns
one remote session's opaque ciphertext replay, while `RelayUsageObject` owns the
account's strongly consistent traffic and attachment budget. Keeping those
coordination atoms separate prevents a busy session from blocking device
management.

## Deploy

```bash
pnpm --filter @jingler/device-relay test
pnpm --filter @jingler/device-relay exec wrangler deploy
```

Configure `DEVICE_RELAY_SIGNING_SECRET` as a Wrangler secret. It must equal the
server's `DEVICE_RELAY_SIGNING_SECRET`, be at least 32 random bytes, and must not
reuse BetterAuth, GitHub relay, webhook, or Memory secrets. The first deployment
applies the `v1` SQLite Durable Object migration in `wrangler.jsonc`.

The public origin is `https://device-relay.jingler.dev`. The server mints
short-lived grants for four disjoint audiences: `device-control`,
`device-challenge`, `device-connect`, and `session-tunnel`. The Worker verifies
audience, subject, device/session scope, generation, TTL, and grant id before
routing. Tunnel storage contains encrypted envelopes and cursors only.

## Durable Object cost controls

- Control and tunnel sockets use the WebSocket Hibernation API; no timer or
  outbound socket keeps an object billed while it is idle.
- Device inventory is hydrated with four bounded, set-based queries rather than
  per-device lookups. Session and audit collections have hard cardinality caps
  and indexed ordering/expiry predicates.
- Tunnel cursors and retention counts are maintained incrementally. Full-table
  backfills are guarded by durable schema-migration markers and run once per
  existing object, not after every hibernation wake.
- Clients send cumulative acknowledgements in bounded batches. Ciphertext usage
  is reserved in chunks and carried in each hibernating socket attachment, so
  ordinary frames do not make a cross-object usage RPC.
- An edge-local authenticated rate limiter rejects abusive attachment storms
  before they wake any registry, tunnel, or usage object; the usage object still
  provides the exact account/client/IP admission fence.
- Alarm targets are only rewritten when the earliest indexed expiry changes.
  Attachments, grants, replay envelopes, and mutation idempotency records are
  pruned by indexed expiry or bounded capacity.

These are part of the correctness boundary: removing a bound, replacing an
indexed predicate with an unbounded scan, or adding an RPC inside the per-frame
path requires an explicit cost review and relay tests.

## Monitoring and recovery

Alert on sustained increases in rejected grants, failed/replayed pairing claims,
reconnect depth, replay truncation, and revocations. A replay-gap response means
the desktop must stop the turn and report recovery failure; it must not silently
rerun a command.

Revocation increments the device generation and closes its control/session
sockets. If the relay is degraded, local sessions remain available and remote
sessions stay assigned to their device—there is no local fallback. Roll back
Worker code without deleting Durable Object storage or migrations. For a
compromised signing secret, deploy a new shared secret to server and Worker,
expire existing grants, and revoke affected devices before removing the old key.
