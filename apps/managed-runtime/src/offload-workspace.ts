import type {
  OffloadAdmissionRequest,
  OffloadJobResult
} from "@jingler/core"
import { Data, Effect } from "effect"

const WORKSPACE = "/workspace"
const EXECUTOR = "/opt/jingler/offload-exec.mjs"

export interface OffloadSandbox {
  readonly exec: (
    command: string,
    options?: {
      cwd?: string
      timeout?: number
      env?: Record<string, string | undefined>
      origin?: "user" | "internal"
    }
  ) => Promise<{ readonly success: boolean; readonly stdout: string; readonly stderr: string }>
  readonly writeFile: (
    path: string,
    content: string | ReadableStream<Uint8Array>
  ) => Promise<unknown>
  readonly readFile: (
    path: string,
    options?: { encoding?: "utf8" }
  ) => Promise<{ readonly content: string }>
}

export class OffloadWorkspaceError extends Data.TaggedError("OffloadWorkspaceError")<{
  readonly reason: "hydration-failed" | "dependency-failed" | "runtime-failed"
  readonly message: string
}> {}

const quote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`
const fixedPath = (jobId: string, suffix: string): string =>
  `/tmp/jingler-offload-${jobId}-${suffix}`

const run = (
  sandbox: OffloadSandbox,
  command: string,
  options: Parameters<OffloadSandbox["exec"]>[1],
  reason: OffloadWorkspaceError["reason"],
  message: string
): Effect.Effect<string, OffloadWorkspaceError> =>
  Effect.tryPromise({
    try: () => sandbox.exec(command, options),
    catch: () => new OffloadWorkspaceError({ reason, message })
  }).pipe(
    Effect.flatMap((result) =>
      result.success
        ? Effect.succeed(result.stdout.trim())
        : Effect.fail(new OffloadWorkspaceError({
            reason,
            message: result.stderr.trim() || message
          }))
    )
  )

export const primeOffloadWorkspace = (
  sandbox: OffloadSandbox
): Effect.Effect<
  { readonly hydrationMs: number; readonly dependencyMs: number; readonly warmSandbox: boolean },
  OffloadWorkspaceError
> =>
  Effect.gen(function* () {
    const started = Date.now()
    const state = yield* run(
      sandbox,
      "if test -f /tmp/jingler-offload-sandbox-ready; then printf warm; else touch /tmp/jingler-offload-sandbox-ready && chmod 0400 /tmp/jingler-offload-sandbox-ready && printf cold; fi",
      { cwd: WORKSPACE, timeout: 30_000, origin: "internal" },
      "runtime-failed",
      "Sandbox could not be primed"
    )
    return {
      hydrationMs: Date.now() - started,
      dependencyMs: 0,
      warmSandbox: state === "warm"
    }
  })

export const restoreOffloadSnapshot = (
  sandbox: OffloadSandbox,
  jobId: string,
  snapshot: Uint8Array,
  admittedBytes: number
): Effect.Effect<{
  readonly sourceDigest: string
  readonly hydrationMs: number
  readonly dependencyMs: number
}, OffloadWorkspaceError> =>
  Effect.gen(function* () {
    const hydrationStarted = Date.now()
    const snapshotPath = fixedPath(jobId, "snapshot.gz")
    yield* Effect.tryPromise({
      try: () => sandbox.writeFile(
        snapshotPath,
        new Blob([snapshot]).stream() as ReadableStream<Uint8Array>
      ),
      catch: () => new OffloadWorkspaceError({
        reason: "hydration-failed",
        message: "Snapshot could not be written to the sandbox"
      })
    })
    yield* run(
      sandbox,
      `node ${EXECUTOR} restore ${quote(snapshotPath)} ${admittedBytes}`,
      { cwd: WORKSPACE, timeout: 120_000, origin: "internal" },
      "hydration-failed",
      "Workspace snapshot could not be restored"
    )
    const hydrationMs = Date.now() - hydrationStarted
    const dependencyStarted = Date.now()
    yield* run(
      sandbox,
      [
        "rm -rf node_modules",
        "if test -f pnpm-lock.yaml; then corepack pnpm install --frozen-lockfile --prefer-offline --ignore-scripts;",
        "elif test -f package-lock.json; then npm ci --ignore-scripts;",
        "elif test -f yarn.lock; then corepack yarn install --immutable --mode=skip-builds; fi"
      ].join("; "),
      { cwd: WORKSPACE, timeout: 10 * 60_000, origin: "internal" },
      "dependency-failed",
      "Dependencies could not be prepared"
    )
    const sourceDigest = yield* run(
      sandbox,
      `node ${EXECUTOR} manifest`,
      { cwd: WORKSPACE, timeout: 30_000, origin: "internal" },
      "hydration-failed",
      "Prepared workspace manifest could not be captured"
    )
    return {
      sourceDigest,
      hydrationMs,
      dependencyMs: Date.now() - dependencyStarted
    }
  })

interface ExecutorResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly outputTruncated: boolean
  readonly timedOut: boolean
  readonly sourceMutated: boolean
  readonly commandMs: number
}

const readExecutorResult = (
  sandbox: OffloadSandbox,
  path: string
): Effect.Effect<ExecutorResult, OffloadWorkspaceError> =>
  Effect.tryPromise({
    try: async () => {
      const file = await sandbox.readFile(path, { encoding: "utf8" })
      const value: unknown = JSON.parse(file.content)
      const fields = typeof value === "object" && value !== null
        ? Object.fromEntries(Object.entries(value))
        : null
      if (
        typeof fields?.exitCode !== "number" ||
        typeof fields.stdout !== "string" ||
        typeof fields.stderr !== "string" ||
        typeof fields.outputTruncated !== "boolean" ||
        typeof fields.timedOut !== "boolean" ||
        typeof fields.sourceMutated !== "boolean" ||
        typeof fields.commandMs !== "number"
      ) throw new Error("Invalid executor result")
      return fields as unknown as ExecutorResult
    },
    catch: () => new OffloadWorkspaceError({
      reason: "runtime-failed",
      message: "Sandbox returned an invalid command result"
    })
  })

export const executeOffloadCommand = (
  sandbox: OffloadSandbox,
  jobId: string,
  request: OffloadAdmissionRequest,
  sourceDigest: string,
  allowStart: boolean,
  timings: { readonly queuedMs: number; readonly snapshotMs: number; readonly hydrationMs: number; readonly dependencyMs: number }
): Effect.Effect<OffloadJobResult, OffloadWorkspaceError> =>
  Effect.gen(function* () {
    const commandPath = fixedPath(jobId, "command.json")
    const resultPath = fixedPath(jobId, "result.json")
    const command = JSON.stringify({
      executable: request.command.executable,
      args: request.command.args,
      cwd: request.command.cwd,
      timeoutMs: request.limits.timeoutSeconds * 1_000,
      outputBytes: request.limits.outputBytes,
      sourceDigest,
      startAllowed: allowStart
    })
    yield* Effect.tryPromise({
      try: () => sandbox.writeFile(commandPath, command),
      catch: () => new OffloadWorkspaceError({
        reason: "runtime-failed",
        message: "Command request could not be written to the sandbox"
      })
    })
    yield* run(
      sandbox,
      `node ${EXECUTOR} run ${quote(commandPath)} ${quote(resultPath)}`,
      {
        cwd: WORKSPACE,
        timeout: request.limits.timeoutSeconds * 1_000 + 10_000,
        origin: "user"
      },
      "runtime-failed",
      "Sandbox command execution failed"
    )
    const result = yield* readExecutorResult(sandbox, resultPath)
    const state = result.timedOut || result.sourceMutated || result.outputTruncated || result.exitCode !== 0
      ? "failed" as const
      : "succeeded" as const
    return {
      version: 1,
      jobId,
      state,
      exitCode: result.exitCode,
      failureReason: result.timedOut
        ? "timed-out"
        : result.sourceMutated
          ? "source-mutated"
          : result.outputTruncated
            ? "output-limit"
            : result.exitCode !== 0
              ? "command-failed"
              : null,
      stdout: result.stdout,
      stderr: result.stderr,
      outputTruncated: result.outputTruncated,
      timings: {
        ...timings,
        commandMs: result.commandMs
      }
    }
  })
