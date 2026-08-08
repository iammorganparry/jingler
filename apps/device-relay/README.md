# @jingler/device-relay

Cloudflare Worker control plane for paired environments. A
`DeviceRegistryObject` owns one user's device identities, pairing codes,
presence, discovery, generations, and revocation. A `SessionTunnelObject` owns
one remote session's opaque ciphertext replay. Keeping those coordination atoms
separate prevents a busy session from blocking device management.

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
