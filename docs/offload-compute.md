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

| Design                   | Outcome                                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| GitHub Actions dispatch  | Rejected for interactive use. It requires pushed state, loses dirty worktree fidelity, and adds queue/setup latency.            |
| Direct Sandbox request   | Retained as the execution primitive, but rejected as the sole coordinator because disconnect and retry races are not durable.   |
| Workflow without Sandbox | Rejected because Workflows coordinate durable steps but do not replace an isolated Linux command environment.                   |
| Workflow plus Sandbox    | Selected. It reuses Jingler's deployed trust boundary and supports durable, low-latency execution against current source state. |

## Product contract

- Enabling Offload Compute authorizes automatic routing; it does not make every
  shell command remotely eligible.
- Built-in presets resolve to shell-free executable/argument vectors. Projects
  may add explicit executable/argument vectors to an allowlist. This classifier
  prevents accidental shell interpretation; it does not treat a package script,
  test runner, compiler plugin, or build tool as trusted code.
- Pipelines, redirects, command substitution, interactive processes, stateful
  commands, secret-bearing environments, and unrecognized top-level commands
  remain local. Eligible repository tooling is still arbitrary code and is
  contained by the Sandbox filesystem, identity, and network boundaries below.
- Once a remote job is admitted, a failure is returned to the agent and operator.
  Jingler never retries it locally without an explicit operator action. The model
  has no local-override argument; the operator must disable Offload Compute before
  retrying locally.
- Tracked source is owned by root and made read-only before the admitted command
  runs as uid 65532. Only designated cache/build-output directories and a private
  temporary home are writable. Any remaining source mutation fails and all
  remote state is discarded.

Automatic routing occurs at the canonical agent command boundary before the
local command executor. The classifier is pure and returns `local` with a reason
unless every eligibility condition is known. It never tries to turn arbitrary
bash text into a supposedly safe argument vector.

## Handoff protocol

1. Resolve the eligible preset or project allowlist entry to an executable,
   argument vector, and repository-relative working directory.
2. Capture a bounded self-contained archive of the exact local `HEAD` plus
   staged and unstaged binary patches. This reproduces local-only commits without
   a push or Git-proxy lookup. Ignored and untracked files are excluded by
   default; an operator must explicitly stage a new file to authorize transfer.
   Re-read Git state after capture and reject a moving worktree, unsafe path,
   symlink/submodule, excluded or secret-prone staged file, or size overflow.
3. Stream a compressed and hashed snapshot to private R2 with a single-use grant
   scoped to the account, session, repository, job, and digest.
4. Start the session-scoped Sandbox and Workflow as soon as admission succeeds.
   A durable `snapshot-ready` event releases restoration when upload completes;
   no remote Git object is required for correctness.
5. Verify and restore the archive and patches, create a synthetic Git baseline,
   and perform a fresh dependency installation with lifecycle scripts disabled.
   Mutable `node_modules` state is never reused between jobs.
6. Make source and dependencies read-only, create only designated writable output
   directories, then launch the literal executable/arguments in a dedicated
   process group through a static seccomp wrapper as uid 65532. The wrapper denies
   Internet, packet, and netlink sockets for the command and descendants. Output
   is retained only up to the admitted combined byte bound, and timeout terminates
   the complete process group before settlement. Compare source manifests
   afterwards as defense in depth and discard all remote job state.

The existing `WorkspaceTransferCheckpoint` remains the continuation format. Its
4 MiB JSON limit is appropriate for interactive continuation but not dependency-
free snapshot streaming. Offload Compute extracts its safe path and Git identity
rules into a compressed format with an initial 64 MiB uncompressed cap. It
excludes `.git`, dependencies, caches, build output, sockets, devices, symlinks,
submodules, ignored files, and all untracked files. Explicitly staged files still
pass secret-prone path checks before transfer.

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
mints a short-lived, single-job capability with upload, read, and cancel actions.
The capability includes the immutable job scope and snapshot digest. Upload and
cancel are consumed once per grant/action pair; resumable reads are reusable only
until expiry. Workflow execution is internal and has no client `run` capability.

Cloudflare service credentials, GitHub installation credentials, and provider
credentials never enter renderer state, Workflow payloads, command arguments,
snapshots, logs, or R2 metadata. Job hydration is self-contained and does not
expose a Git-proxy capability to the command. Dependency fetching happens before
the unprivileged command with lifecycle scripts disabled. The command and all of
its descendants inherit a seccomp network filter that denies new Internet,
packet, and netlink sockets, so they cannot reach control-plane, metadata, Git,
R2, or arbitrary exfiltration endpoints. Command output is bounded and redacted
before durable storage.

Each desktop request carries an idempotency key namespaced by authenticated
subject. Admission persists the complete immutable session/repository/snapshot/
command/limit request and rejects reuse if any field differs. R2 job mutations
use ETag compare-and-swap retries, preserving cancellation, event sequencing,
execution ownership, and terminal settlement under concurrent callers. Snapshot
upload validates bounded compressed and decompressed sizes and the digest before
publication; the upload action is consumed only after the R2 object and Workflow
event are durable, and exact retries are idempotent. The Workflow
instance id is stable for that authenticated scope. Before spawn, the executor
atomically creates a job-specific marker in the session Sandbox. A retry may
recover a durable terminal result or wait on an existing marker, but it may not
start when durable ownership is already `running`; loss of the Sandbox therefore
fails indeterminately instead of executing twice. Event sequence numbers provide
resumable, deduplicated logs after a desktop disconnect. Desktop polling uses
bounded exponential backoff and stops at the admitted lifecycle deadline.
Short-lived scoped
capabilities are standard HS256 JWTs issued and verified by `jose`; Jingler does
not implement JWT encoding, parsing, or signature verification itself.

## Limits and lifecycle

Initial limits are 64 MiB of snapshot input, 4 MiB of returned output, 30 minutes
per command, one outstanding job per account (including upload and execution),
and the managed runtime's global Sandbox cap. Admission claims that slot before
returning an upload capability, so additional jobs are rejected rather than
queued. An abandoned slot expires after two hours, above the complete worst-case Workflow lifecycle; job/snapshot objects expire
after one day. Production values remain server-controlled and may be lower by
account tier. A warm Sandbox reuses only container startup state and package-
manager download caches; each job deletes and freshly installs `node_modules`
from its own manifests and lockfile before making dependencies read-only.
Enabling offload persists the routing choice first, then primes sessions through
a best-effort background queue capped at three concurrent requests; stale-session
failures do not make the saved toggle lie. Resuming a session refreshes its primer.
Archiving or
deleting the session destroys its Sandbox immediately. A Durable Object activity
lease destroys any remaining Sandbox after three inactive hours; a later resume
creates and primes a fresh one.

Job states are `capturing`, `uploading`, `queued`, `preparing`, `running`,
`cancelling`, and terminal `succeeded`, `failed`, or `cancelled`. Terminal
metadata records phase timings, exit status, output truncation, and a reason code
without recording repository paths or raw command text in telemetry.

## Observability and rollout

The aggregate-only `offload_compute_settled` event measures queue, snapshot,
hydration, dependency, and command durations separately and records only outcome,
typed failure reason, warm-Sandbox state, and output truncation. It never
contains account/session/job identity, repository, command, argv, output, or path.
The initial targets are a warm p95 under five seconds from handoff to command
start and a cold p95 under twenty seconds excluding dependency installation and
external repository failure. The scheduled production benchmark enforces both
thresholds; the dashboard alerts on retry exhaustion, Sandbox capacity, cleanup
backlog, digest mismatch, and unexpected source mutation. Provisioning, smoke,
benchmark, alert thresholds, rollback, and incident steps live in
[`runbooks/offload-compute.md`](runbooks/offload-compute.md).

Roll out in order: managed-runtime Workflow support, API admission and grants,
desktop setting/router, then account eligibility. Roll back by disabling new
admission first while preserving read and cancel until active jobs settle. Local
command execution remains unchanged for disabled or ineligible commands.
