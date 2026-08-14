import { Schema } from "effect"

export const OFFLOAD_COMPUTE_PROTOCOL_VERSION = 1 as const
export const OFFLOAD_SNAPSHOT_MAX_BYTES = 64 * 1024 * 1024
export const OFFLOAD_OUTPUT_MAX_BYTES = 4 * 1024 * 1024
export const OFFLOAD_TIMEOUT_MAX_SECONDS = 30 * 60

export const OffloadPreset = Schema.Literal("lint", "typecheck", "test", "build")
export type OffloadPreset = Schema.Schema.Type<typeof OffloadPreset>

const SafeExecutable = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(128),
  Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u, {
    identifier: "OffloadExecutable"
  })
)

const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/u
const PRESET_NAMES = new Set<OffloadPreset>(["lint", "typecheck", "test", "build"])

const hasControlCharacter = (value: string): boolean =>
  Array.from(value).some((character) => {
    const point = character.codePointAt(0) ?? 0
    return point < 0x20 || point === 0x7f
  })

const SafeArgument = Schema.String.pipe(
  Schema.maxLength(4_096),
  Schema.filter((value) => !hasControlCharacter(value), {
    message: () => "Offload command arguments cannot contain control characters"
  })
)

const safeRelativeDirectory = (value: string): boolean =>
  value === "." ||
  (value.length > 0 &&
    value.length <= 4_096 &&
    !value.startsWith("/") &&
    !value.startsWith("\\") &&
    !WINDOWS_ABSOLUTE_PATH.test(value) &&
    !value.includes("\\") &&
    value.split("/").every((part) => part.length > 0 && part !== "." && part !== ".."))

export const OffloadWorkingDirectory = Schema.String.pipe(
  Schema.filter(safeRelativeDirectory, {
    message: () => "Offload working directory must remain inside the repository"
  })
)
export type OffloadWorkingDirectory = Schema.Schema.Type<typeof OffloadWorkingDirectory>

export const OffloadExplicitCommand = Schema.Struct({
  executable: SafeExecutable,
  args: Schema.Array(SafeArgument).pipe(Schema.maxItems(128)),
  cwd: OffloadWorkingDirectory
})
export type OffloadExplicitCommand = Schema.Schema.Type<typeof OffloadExplicitCommand>

export const OffloadAllowedCommand = Schema.Struct({
  id: Schema.String.pipe(
    Schema.minLength(1),
    Schema.maxLength(64),
    Schema.pattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, { identifier: "OffloadCommandId" })
  ),
  command: OffloadExplicitCommand
})
export type OffloadAllowedCommand = Schema.Schema.Type<typeof OffloadAllowedCommand>

export const OffloadComputeSettings = Schema.Struct({
  enabled: Schema.Boolean,
  explicitCommands: Schema.Array(OffloadAllowedCommand).pipe(Schema.maxItems(32))
})
export type OffloadComputeSettings = Schema.Schema.Type<typeof OffloadComputeSettings>

export const DEFAULT_OFFLOAD_COMPUTE_SETTINGS: OffloadComputeSettings = {
  enabled: false,
  explicitCommands: []
}

export const OffloadResolvedCommand = Schema.Union(
  Schema.Struct({
    source: Schema.Struct({ kind: Schema.Literal("preset"), preset: OffloadPreset }),
    executable: SafeExecutable,
    args: Schema.Array(SafeArgument).pipe(Schema.maxItems(128)),
    cwd: OffloadWorkingDirectory
  }),
  Schema.Struct({
    source: Schema.Struct({
      kind: Schema.Literal("explicit"),
      commandId: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(64))
    }),
    executable: SafeExecutable,
    args: Schema.Array(SafeArgument).pipe(Schema.maxItems(128)),
    cwd: OffloadWorkingDirectory
  })
)
export type OffloadResolvedCommand = Schema.Schema.Type<typeof OffloadResolvedCommand>

export const OffloadJobLimits = Schema.Struct({
  timeoutSeconds: Schema.Int.pipe(Schema.between(1, OFFLOAD_TIMEOUT_MAX_SECONDS)),
  snapshotBytes: Schema.Int.pipe(Schema.between(1, OFFLOAD_SNAPSHOT_MAX_BYTES)),
  outputBytes: Schema.Int.pipe(Schema.between(1, OFFLOAD_OUTPUT_MAX_BYTES))
})
export type OffloadJobLimits = Schema.Schema.Type<typeof OffloadJobLimits>

const OpaqueOffloadId = Schema.String.pipe(
  Schema.minLength(16),
  Schema.maxLength(128),
  Schema.pattern(/^[A-Za-z0-9_-]+$/u, { identifier: "OpaqueOffloadId" })
)
const Sha256Digest = Schema.String.pipe(
  Schema.pattern(/^[a-f0-9]{64}$/u, { identifier: "ContentDigest" })
)

export const OffloadRepositorySlug = Schema.String.pipe(
  Schema.pattern(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u, {
    identifier: "OffloadRepositorySlug"
  })
)
export type OffloadRepositorySlug = Schema.Schema.Type<typeof OffloadRepositorySlug>

export const OffloadSnapshotIdentity = Schema.Struct({
  version: Schema.Literal(OFFLOAD_COMPUTE_PROTOCOL_VERSION),
  headSha: Schema.String.pipe(
    Schema.pattern(/^[a-f0-9]{40,64}$/iu, { identifier: "ExactGitSha" })
  ),
  digest: Sha256Digest,
  bytes: Schema.Int.pipe(Schema.between(1, OFFLOAD_SNAPSHOT_MAX_BYTES))
})
export type OffloadSnapshotIdentity = Schema.Schema.Type<typeof OffloadSnapshotIdentity>

export const OffloadJobState = Schema.Literal(
  "capturing",
  "uploading",
  "queued",
  "preparing",
  "running",
  "cancelling",
  "succeeded",
  "failed",
  "cancelled"
)
export type OffloadJobState = Schema.Schema.Type<typeof OffloadJobState>

export const OffloadFailureReason = Schema.Literal(
  "admission-denied",
  "snapshot-invalid",
  "hydration-failed",
  "dependency-failed",
  "command-failed",
  "source-mutated",
  "timed-out",
  "output-limit",
  "capacity",
  "runtime-failed"
)
export type OffloadFailureReason = Schema.Schema.Type<typeof OffloadFailureReason>

const OffloadPhaseTimings = Schema.Struct({
  queuedMs: Schema.Int.pipe(Schema.nonNegative()),
  snapshotMs: Schema.Int.pipe(Schema.nonNegative()),
  hydrationMs: Schema.Int.pipe(Schema.nonNegative()),
  dependencyMs: Schema.Int.pipe(Schema.nonNegative()),
  commandMs: Schema.Int.pipe(Schema.nonNegative())
})

export const OffloadJobResult = Schema.Struct({
  version: Schema.Literal(OFFLOAD_COMPUTE_PROTOCOL_VERSION),
  jobId: OpaqueOffloadId,
  state: Schema.Literal("succeeded", "failed", "cancelled"),
  exitCode: Schema.NullOr(Schema.Int.pipe(Schema.between(0, 255))),
  failureReason: Schema.NullOr(OffloadFailureReason),
  stdout: Schema.String.pipe(Schema.maxLength(OFFLOAD_OUTPUT_MAX_BYTES)),
  stderr: Schema.String.pipe(Schema.maxLength(OFFLOAD_OUTPUT_MAX_BYTES)),
  outputTruncated: Schema.Boolean,
  timings: OffloadPhaseTimings
})
export type OffloadJobResult = Schema.Schema.Type<typeof OffloadJobResult>

export const OffloadJobEvent = Schema.Union(
  Schema.Struct({
    version: Schema.Literal(OFFLOAD_COMPUTE_PROTOCOL_VERSION),
    jobId: OpaqueOffloadId,
    sequence: Schema.Int.pipe(Schema.positive()),
    kind: Schema.Literal("state"),
    state: OffloadJobState
  }),
  Schema.Struct({
    version: Schema.Literal(OFFLOAD_COMPUTE_PROTOCOL_VERSION),
    jobId: OpaqueOffloadId,
    sequence: Schema.Int.pipe(Schema.positive()),
    kind: Schema.Literal("output"),
    stream: Schema.Literal("stdout", "stderr"),
    text: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(64 * 1024))
  }),
  Schema.Struct({
    version: Schema.Literal(OFFLOAD_COMPUTE_PROTOCOL_VERSION),
    jobId: OpaqueOffloadId,
    sequence: Schema.Int.pipe(Schema.positive()),
    kind: Schema.Literal("result"),
    result: OffloadJobResult
  })
)
export type OffloadJobEvent = Schema.Schema.Type<typeof OffloadJobEvent>

export const OffloadAdmissionRequest = Schema.Struct({
  version: Schema.Literal(OFFLOAD_COMPUTE_PROTOCOL_VERSION),
  sessionId: OpaqueOffloadId,
  idempotencyKey: OpaqueOffloadId,
  repositorySlug: OffloadRepositorySlug,
  snapshot: OffloadSnapshotIdentity,
  command: OffloadResolvedCommand,
  limits: OffloadJobLimits
})
export type OffloadAdmissionRequest = Schema.Schema.Type<typeof OffloadAdmissionRequest>

export const OFFLOAD_GRANT_MAX_TTL_SECONDS = 5 * 60
export const OffloadGrantAction = Schema.Literal(
  "snapshot.upload",
  "job.run",
  "job.read",
  "job.cancel",
  "git.read"
)
export type OffloadGrantAction = Schema.Schema.Type<typeof OffloadGrantAction>

export const OffloadGrantClaims = Schema.Struct({
  version: Schema.Literal(OFFLOAD_COMPUTE_PROTOCOL_VERSION),
  issuer: Schema.Literal("jingler"),
  audience: Schema.Literal("offload-compute"),
  grantId: OpaqueOffloadId,
  subject: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256)),
  sessionId: OpaqueOffloadId,
  jobId: OpaqueOffloadId,
  idempotencyKey: OpaqueOffloadId,
  repositorySlug: OffloadRepositorySlug,
  snapshotDigest: Sha256Digest,
  actions: Schema.Array(OffloadGrantAction).pipe(Schema.minItems(1), Schema.maxItems(5)),
  issuedAt: Schema.Int.pipe(Schema.nonNegative()),
  expiresAt: Schema.Int.pipe(Schema.positive())
})
export type OffloadGrantClaims = Schema.Schema.Type<typeof OffloadGrantClaims>

export const OffloadAdmissionResponse = Schema.Struct({
  version: Schema.Literal(OFFLOAD_COMPUTE_PROTOCOL_VERSION),
  jobId: OpaqueOffloadId,
  runtimeUrl: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(2_048)),
  uploadUrl: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(2_048)),
  grant: Schema.String.pipe(Schema.minLength(16), Schema.maxLength(16_384)),
  expiresAt: Schema.Int.pipe(Schema.positive())
})
export type OffloadAdmissionResponse = Schema.Schema.Type<typeof OffloadAdmissionResponse>

export type OffloadLocalReason =
  | "disabled"
  | "interactive"
  | "shell-features"
  | "stateful"
  | "secret-environment"
  | "unsafe-cwd"
  | "unknown-command"

export interface ObservedAgentCommand {
  readonly executable: string
  readonly args: ReadonlyArray<string>
  readonly cwd: string
  readonly interactive: boolean
  readonly usesShellFeatures: boolean
  readonly mutatesSource: boolean
  readonly environmentKeys: ReadonlyArray<string>
}

export type OffloadRoutingDecision =
  | { readonly target: "local"; readonly reason: OffloadLocalReason }
  | { readonly target: "offload"; readonly command: OffloadResolvedCommand }

const SECRET_ENVIRONMENT_KEY =
  /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASS|PRIVATE_KEY|API_KEY|ACCESS_KEY|AUTH)(?:_|$)/iu

const commandEquals = (
  observed: ObservedAgentCommand,
  configured: OffloadExplicitCommand
): boolean =>
  observed.executable === configured.executable &&
  observed.cwd === configured.cwd &&
  observed.args.length === configured.args.length &&
  observed.args.every((argument, index) => argument === configured.args[index])

const packageScript = (command: ObservedAgentCommand): string | undefined => {
  const [first, second, ...rest] = command.args
  if (rest.length > 0) return
  if (command.executable === "npm" || command.executable === "bun") {
    return first === "run" ? second : undefined
  }
  if (command.executable === "pnpm" || command.executable === "yarn") {
    return first === "run" ? second : first
  }
}

const presetFor = (command: ObservedAgentCommand): OffloadPreset | null => {
  const script = packageScript(command)
  return script !== undefined && PRESET_NAMES.has(script as OffloadPreset)
    ? script as OffloadPreset
    : null
}

const validCommandShape = (command: ObservedAgentCommand): boolean => {
  const decoded = Schema.decodeUnknownEither(OffloadExplicitCommand)({
    executable: command.executable,
    args: command.args,
    cwd: command.cwd
  }, { onExcessProperty: "error" })
  return decoded._tag === "Right"
}

/** Pure, fail-closed routing policy used before the local command executor. */
export const classifyOffloadCommand = (
  settings: OffloadComputeSettings,
  command: ObservedAgentCommand
): OffloadRoutingDecision => {
  if (!settings.enabled) return { target: "local", reason: "disabled" }
  if (command.interactive) return { target: "local", reason: "interactive" }
  if (command.usesShellFeatures) return { target: "local", reason: "shell-features" }
  if (command.mutatesSource) return { target: "local", reason: "stateful" }
  if (command.environmentKeys.some((key) => SECRET_ENVIRONMENT_KEY.test(key))) {
    return { target: "local", reason: "secret-environment" }
  }
  if (!(safeRelativeDirectory(command.cwd) && validCommandShape(command))) {
    return { target: "local", reason: "unsafe-cwd" }
  }
  const preset = presetFor(command)
  if (preset !== null) {
    return {
      target: "offload",
      command: {
        source: { kind: "preset", preset },
        executable: command.executable,
        args: [...command.args],
        cwd: command.cwd
      }
    }
  }
  const explicit = settings.explicitCommands.find((candidate) =>
    commandEquals(command, candidate.command)
  )
  return explicit === undefined
    ? { target: "local", reason: "unknown-command" }
    : {
        target: "offload",
        command: {
          source: { kind: "explicit", commandId: explicit.id },
          executable: command.executable,
          args: [...command.args],
          cwd: command.cwd
        }
      }
}

const transitions: Readonly<Record<OffloadJobState, ReadonlySet<OffloadJobState>>> = {
  capturing: new Set(["uploading", "failed", "cancelled"]),
  uploading: new Set(["queued", "failed", "cancelled"]),
  queued: new Set(["preparing", "cancelling", "failed", "cancelled"]),
  preparing: new Set(["running", "cancelling", "failed", "cancelled"]),
  running: new Set(["cancelling", "succeeded", "failed", "cancelled"]),
  cancelling: new Set(["cancelled", "failed"]),
  succeeded: new Set(),
  failed: new Set(),
  cancelled: new Set()
}

export const canTransitionOffloadJob = (
  from: OffloadJobState,
  to: OffloadJobState
): boolean => transitions[from].has(to)
