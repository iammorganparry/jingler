# Remote environments

Remote environments let a signed-in desktop run Jingler sessions on another
machine such as `clive.local` without logging Jingler into that machine over SSH.
BetterAuth remains the user identity authority; the paired machine receives its
own revocable asymmetric identity.

## Trust boundaries

1. The desktop keeps its BetterAuth bearer in its OS keychain and exchanges it
   for short-lived, audience-scoped relay grants.
2. The device keeps Ed25519/X25519 private keys locally and proves possession
   with signed challenges. Its grants cannot call desktop-control endpoints.
3. Desktop and device derive a per-session key. Commands, prompts, tool events,
   paths, and results are AES-256-GCM encrypted before reaching the relay.
4. The device uses Git and harness credentials already configured on that host.
   Jingler does not synchronize SSH keys, provider tokens, shell profiles, or
   arbitrary secrets.

Pairing codes are random, hashed at rest, short-lived, and single-use. SSH
bootstrap preserves the operator's host-key policy, uses `BatchMode`, and never
collects a password. Public Git services are excluded from host suggestions.

## User workflow

Open **Settings → Devices → Add environment**, then choose:

- **SSH** to select a concrete host from `~/.ssh/config`/`known_hosts`, upload or
  install the bundled agent and its managed Node runtime, register a persistent
  user service, and claim its result; or
- **Remote link** to enter a pending device id and code from an already-running
  agent using the same account-server origin.

Choose the environment when creating a session or from the composer. The
sidebar shows the persisted choice. A pristine session can be re-provisioned in
place. Once turns, tokens, commits, or dirty files exist, changing environment
creates an explicit continuation and leaves the source session intact. The
selector is disabled while a turn or handoff is active.

Offline devices remain visible and their sessions do not fall back locally.
Incompatible agents are blocked until upgraded. Revoking a device removes it
from selectors and closes its remote sessions without affecting local sessions.

## Development and verification

Run the server, relay, and desktop with matching URLs/secrets, then build the
agent bundle. The production variables are:

| Component | Variable | Purpose |
|---|---|---|
| Desktop/agent | `JINGLER_DEVICE_RELAY_URL` | Public relay origin |
| Server | `DEVICE_RELAY_URL` | Server-to-relay origin |
| Server/relay | `DEVICE_RELAY_SIGNING_SECRET` | Shared grant-signing key |

The Electron e2e is hermetic: it creates throwaway desktop/device homes, a fake
`clive.local` SSH transport, local auth/relay servers, and a real bundled device
agent with the scripted harness. It never reads the developer's SSH files or
credentials.

```bash
pnpm --filter @jingler/device-agent build
pnpm --filter @jingler/desktop e2e -- remote-environments.spec.ts
```

Deployment order is relay → server grant endpoints → desktop/agent bundle →
feature flag. Roll back in reverse while retaining Durable Object data. During
an incident, disable new pairing first; revocation and existing local work must
remain available.
