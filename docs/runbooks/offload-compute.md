# Offload Compute operations

## Production dependencies

The managed-runtime deployment owns these resources:

- Workflow `jingler-offload-compute` bound as `OFFLOAD_WORKFLOW`.
- R2 bucket `jingler-offload-jobs` bound as `OFFLOAD_JOBS`, with the
  `expire-offload-jobs` one-day lifecycle rule.
- Sandbox container class `Sandbox` and lifecycle Durable Object
  `OffloadSandboxLifecycleObject`.
- Secrets `MANAGED_RUNTIME_SERVICE_SECRET` and `MANAGED_RUNTIME_GRANT_SECRET`,
  each at least 32 characters. Rotate them together with the control plane.

`.github/workflows/deploy-workers.yml` checks the secrets before deployment,
creates missing buckets/lifecycle rules, runs Wrangler's dry-run, deploys, and
calls the authenticated offload smoke probe. A deployment is not healthy until
that probe confirms R2, the Sandbox image/executor, seccomp egress denial,
unprivileged read-only source enforcement, and the lifecycle object.

## Manual smoke and benchmark

```sh
curl --fail --silent --show-error \
  -X POST \
  -H "x-jingler-service-secret: $MANAGED_RUNTIME_SERVICE_SECRET" \
  https://managed-runtime.jingler.dev/v1/offload-probe | jq

MANAGED_RUNTIME_SERVICE_SECRET="$MANAGED_RUNTIME_SERVICE_SECRET" \
OFFLOAD_BENCHMARK_SAMPLES=20 \
pnpm --filter @jingler/managed-runtime benchmark:offload
```

The benchmark creates a fresh Sandbox for every cold sample, measures the first
command handoff, then measures a second command on that Sandbox. It fails unless
cold p95 is below 20 seconds and warm p95 is below 5 seconds. Run it after a
Sandbox image/runtime change and weekly from an operator workstation. Record the
JSON result with the release; never record the service secret.

## Telemetry and alerts

`offload_compute_settled` is the only job telemetry event. It contains terminal
outcome, typed failure reason, warm-dependency flag, output-truncation flag, and
queued/snapshot/hydration/dependency/command milliseconds. It deliberately has
no account, session, job, repository, command, argv, output, or path.

Create Cloudflare dashboard charts split by `warmSandbox`, `outcome`, and
`failureReason`, with p50/p95 for every timing field. Configure these alerts:

1. Warm `queuedMs + hydrationMs` p95 at or above 5,000 ms for 15 minutes (minimum
   20 jobs), or cold p95 at or above 20,000 ms.
2. Failed/cancelled outcomes above 5% for 15 minutes (minimum 20 jobs), split by
   failure reason.
3. `runtime-failed`, `hydration-failed`, or `dependency-failed` above 2% for 10
   minutes, and any authenticated offload smoke failure.
4. A Workflow still active after 80 minutes, or lifecycle cleanup errors for 15
   minutes.

## Incident response

1. Disable `OFFLOAD_COMPUTE_ENABLED` on the control plane. Desktop classification
   then uses the unchanged local path for new commands; already admitted remote
   failures never silently fall back.
2. Inspect failure-reason and phase-timing splits before inspecting sampled logs.
   Logs must not be augmented with commands, output, paths, grants, or subjects.
3. For a bad image, roll back managed-runtime to the previous deployment and run
   the smoke probe. For R2/Workflow trouble, keep admission disabled until both
   bindings and the one-day lifecycle rule are present.
4. Destroy a known session Sandbox through the authenticated
   `/api/offload/sandboxes/destroy` control-plane route. The inactivity alarm is
   the fallback and removes untouched Sandboxes after three hours.
5. Re-enable admission, run 20 benchmark samples, and watch failure rate and warm
   p95 for 15 minutes.
