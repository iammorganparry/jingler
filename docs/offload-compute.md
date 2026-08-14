# Offload Compute

## Decision

Jingler will offload eligible compute-heavy agent commands through a Cloudflare
Workflow that coordinates the existing `@cloudflare/sandbox` managed runtime.
The feature is disabled by default. Once enabled globally or for a project,
recognized lint, typecheck, test, and build commands are routed automatically;
all other commands keep the existing local path.

A Workflow is the durable control plane, not the executor. It owns idempotency,
retries, cancellation, event cursors, retention, and cleanup. A session-scoped
Sandbox is the Linux executor. Private R2 objects carry bounded workspace
snapshots and result chunks that are too large for Workflow parameters.

### Alternatives considered

| Design | Outcome |
| --- | --- |
| GitHub Actions dispatch | Rejected for interactive use. It requires pushed state, loses dirty worktree fidelity, and adds queue/setup latency. |
| Direct Sandbox request | Retained as the execution primitive, but rejected as the sole coordinator because disconnect and retry races are not durable. |
| Workflow without Sandbox | Rejected because Workflows coordinate durable steps but do not replace an isolated Linux command environment. |
| Workflow plus Sandbox | Selected. It reuses Jingler's deployed trust boundary and supports durable, low-latency execution against current source state. |

## Product contract

- Enabling Offload Compute authorizes automatic routing; it does not make every
  shell command remotely eligible.
- Built-in presets resolve to shell-free executable/argument vectors. Projects
  may add explicit executable/argument vectors to an allowlist.
- Pipelines, redirects, command substitution, interactive processes, stateful
  commands, secret-bearing environments, and unknown scripts remain local.
- Once a remote job is admitted, a failure is returned to the agent and operator.
  Jingler never retries it locally without an explicit operator action.
- The remote source tree is read-only from the product's perspective. A command
  that changes tracked or untracked source fails; remote changes are discarded.

Automatic routing occurs at the canonical agent command boundary before the
local command executor. The classifier is pure and returns `local` with a reason
unless every eligibility condition is known. It never tries to turn arbitrary
bash text into a supposedly safe argument vector.

## Handoff protocol

1. Resolve the eligible preset or project allowlist entry to an executable,
   argument vector, and repository-relative working directory.
2. Capture the exact `HEAD`, staged and unstaged binary patches, and allowed
   untracked regular files. Re-read Git state after capture and reject a moving
   worktree, unsafe path, symlink, excluded secret file, or size overflow.
3. Stream a compressed and hashed snapshot to private R2 with a single-use grant
   scoped to the account, session, repository, job, and digest.
4. Hydrate the exact commit through the existing scoped Git proxy, restore the
   snapshot, and verify its digest before command admission.
5. Execute the literal executable and arguments with no shell interpolation.
   Compare source manifests afterwards and discard the Sandbox state if source
   changed.

The existing `WorkspaceTransferCheckpoint` remains the continuation format. Its
4 MiB JSON limit is appropriate for interactive continuation but not dependency-
free snapshot streaming. Offload Compute extracts its safe path and Git identity
rules into a compressed format with an initial 64 MiB uncompressed cap. It
excludes `.git`, dependencies, caches, build output, sockets, devices, symlinks,
and known local secret files.

## Effect-TS architecture

All backend Offload Compute business logic uses Effect-TS in the repository's
established style. Cross-process and persisted values are Effect `Schema`
contracts. Snapshot, admission, runtime-client, and routing services are
`Effect.Service` implementations with explicit Layer dependencies. Expected
failures use typed tagged errors and stay in the Effect error channel; filesystem,
network, compression, R2, Workflow, and Sandbox promises enter through
`Effect.tryPromise` at narrow adapters. Multi-step admission, upload, execution,
and cleanup programs use `Effect.gen`, scoped resource finalizers, interruption,
and structured Effect logging.

Cloudflare Worker `fetch`, Workflow `run`, Electron RPC, and renderer Promise
methods are transport adapters only: they provide Layers, run one Effect program,
and encode its typed result. Pure schema refinements, state-transition predicates,
and command classification remain deterministic functions in `packages/core`;
they do not acquire side effects merely to appear effectful.

## Trust boundaries

The authenticated API derives the subject, account eligibility, session, and
repository. The renderer and agent cannot assert authoritative ownership. It
mints a short-lived, single-job capability with separate upload, run, read, and
cancel actions. The capability includes the snapshot digest and is single use.

Cloudflare service credentials, GitHub installation credentials, and provider
credentials never enter renderer state, Workflow payloads, command arguments,
snapshots, logs, or R2 metadata. Git hydration continues to use the existing
session-scoped Git proxy. Command output is bounded and redacted before durable
storage.

Each desktop request carries an idempotency key. The Workflow instance id is
stable for that key, and command execution obtains a durable lease before the
Sandbox starts. Workflow step retries can recover a recorded result but cannot
execute the command twice. Event sequence numbers provide resumable, deduplicated
logs after a desktop disconnect.

## Limits and lifecycle

Initial limits are 64 MiB of snapshot input, 4 MiB of returned output, 30 minutes
per command, one active job per account, and the managed runtime's global
Sandbox cap. Production values remain server-controlled and may be lower by
account tier. A warm Sandbox may reuse a dependency installation only when its
runtime image and lockfile digests match; every job still revalidates `HEAD`, the
snapshot, and the clean source baseline.

Job states are `capturing`, `uploading`, `queued`, `preparing`, `running`,
`cancelling`, and terminal `succeeded`, `failed`, or `cancelled`. Terminal
metadata records phase timings, exit status, output truncation, and a reason code
without recording repository paths or raw command text in telemetry.

## Observability and rollout

Measure queue, snapshot, hydration, dependency, and command durations separately.
The initial targets are a warm p95 under five seconds from handoff to command
start and a cold p95 under twenty seconds excluding dependency installation and
external repository failure. Alert on admission denial, Workflow retry
exhaustion, Sandbox capacity, cleanup backlog, digest mismatch, and unexpected
source mutation.

Roll out in order: managed-runtime Workflow support, API admission and grants,
desktop setting/router, then account eligibility. Roll back by disabling new
admission first while preserving read and cancel until active jobs settle. Local
command execution remains unchanged for disabled or ineligible commands.
