# @jingler/device-agent

The headless runtime for a paired Jingler environment. It owns a device signing
key and X25519 encryption key on the remote machine, opens outbound control and
session WebSockets, and executes typed session operations with the machine's own
Git and harness credentials. A desktop BetterAuth token is never installed here.

## Build and bootstrap

```bash
pnpm --filter @jingler/device-agent build
node apps/device-agent/dist/jingler-device.mjs pair \
  --relay https://device-relay.jingler.dev --json
```

The desktop's SSH flow runs the equivalent command through an existing trusted
SSH alias, claims the one-time result while signed in, and installs `serve` as a
per-user launchd or systemd service. If the host does not already provide Node
22, bootstrap installs a pinned, checksum-verified private runtime under
`~/.local/share/jingler/runtime`. SSH is a bootstrap transport only; normal work
uses the relay.

For a manual first activation:

```bash
node jingler-device.mjs serve \
  --subject USER_SUBJECT \
  --device-id DEVICE_ID \
  --server https://api.jingler.dev
```

The first activation persists enrollment under `$JINGLER_HOME/jingler/device`
(or `~/jingler/device`). Private files are mode `0600`; the directory is `0700`.
Subsequent starts need only `serve`. Use `status`, `rotate-key`, and
`revoke-local` for inspection and local recovery.

## Operations

- The daemon refreshes a short-lived `device-connect` grant by signing a fresh
  server challenge. Repeated `403`/revoked responses stop reconnecting.
- SIGINT and SIGTERM abort both server grant requests and relay admission. A
  server-side revoke removes the persistent service definition before the
  daemon exits, so it cannot restart against a revoked identity after login.
- Session command admission and encrypted outgoing envelopes are persisted under
  `device/sessions/` before acknowledgement, providing exactly-once execution
  across relay reconnects.
- A device advertises a protocol version and capabilities. Upgrade the bundled
  agent when the desktop reports `incompatible`; do not force commands across a
  protocol mismatch.
- To rotate identity, revoke the paired device first (or complete the
  server-authorized rotation flow), run `rotate-key`, and pair again.

Tests: `pnpm --filter @jingler/device-agent test`.
