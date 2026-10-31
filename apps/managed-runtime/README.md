# Jingler managed runtime

Cloudflare Worker, Durable Objects, and one isolated Sandbox
container per active managed session.

## Production prerequisites

The deploy workflow verifies the existing `jingler-auth-state` Worker, deploys the runtime, and then
publishes its Worker secrets. Configure these GitHub Actions secrets before the
first deployment:

- `MANAGED_RUNTIME_SERVICE_SECRET` — the same 32+ byte value configured on the
  API server and auth-state Worker.
- `MANAGED_RUNTIME_GRANT_SECRET` — an independent 32+ byte signing key.

The runtime is capped at ten global `basic` instances and the API admits only
one active usage interval per account. It uses RPC transport, sleeps after two
settled minutes, and excludes
dependency/build/cache directories.

## Verification

```sh
pnpm --filter @jingler/managed-runtime test
pnpm --filter @jingler/managed-runtime typecheck
pnpm --filter @jingler/managed-runtime deploy:dry
```

Do not enable `MANAGED_ENVIRONMENTS_ENABLED` until migration `0009` and
`drizzle/verify_managed_environments.sql` have both succeeded in production.
