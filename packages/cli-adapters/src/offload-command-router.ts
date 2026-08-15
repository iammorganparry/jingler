import { createHash } from "node:crypto"
import {
  DEFAULT_OFFLOAD_COMPUTE_SETTINGS,
  OFFLOAD_COMPUTE_PROTOCOL_VERSION,
  OFFLOAD_OUTPUT_MAX_BYTES,
  OFFLOAD_TIMEOUT_MAX_SECONDS,
  OffloadAdmissionResponse,
  OffloadEventPage,
  classifyOffloadCommand,
  parseObservedAgentShellCommand,
  type OffloadAdmissionRequest,
  type OffloadJobEvent,
  type OffloadJobResult
} from "@jingler/core"
import { CommandExecutor, FileSystem } from "@effect/platform"
import { Effect, Schema } from "effect"
import { AppPaths } from "./app-paths.js"
import { ConfigService } from "./config.js"
import { GitService } from "./git.js"
import { parseGitHubRemote } from "./github-remote.js"
import {
  captureOffloadSnapshot,
  uploadOffloadSnapshot,
  type CapturedOffloadSnapshot
} from "./offload-snapshot.js"
import { SecretStore } from "./secret-store.js"
import {
  makeResourcePressureMonitor,
  type ResourcePressurePort
} from "./resource-pressure.js"
import {
  ToolError,
  type ToolExecutionContext
} from "./runtime/tools/tool-registry.js"

export interface OffloadedCommandResult {
  readonly command: string
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly offloaded: true
  readonly jobId: string
}

export interface OwnedDeviceOffloadPort {
  readonly execute: (input: {
    readonly deviceId: string
    readonly jobId: string
    readonly snapshot: CapturedOffloadSnapshot
    readonly command: OffloadAdmissionRequest["command"]
    readonly limits: OffloadAdmissionRequest["limits"]
    readonly context: ToolExecutionContext
  }) => Effect.Effect<OffloadedCommandResult, ToolError>
}

export interface OffloadCommandRouterPort {
  readonly primeSession: (
    cwd: string,
    sessionId: string
  ) => Effect.Effect<"disabled" | "accepted", ToolError>
  readonly destroySession: (
    sessionId: string
  ) => Effect.Effect<void, ToolError>
  readonly executeIfEligible: (
    cwd: string,
    sessionId: string,
    source: string,
    context: ToolExecutionContext
  ) => Effect.Effect<OffloadedCommandResult | null, ToolError>
}

const failure = (message: string, retryable = false): ToolError =>
  new ToolError("execution-failed", message, retryable)

const opaqueId = (prefix: "session" | "request", value: string): string =>
  `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 32)}`

const serverBaseUrl = (): string =>
  process.env.JINGLER_AUTH_URL ?? "http://localhost:9100"

const responseError = async (response: Response, fallback: string): Promise<ToolError> => {
  const body: unknown = await response.json().catch(() => null)
  const message = typeof body === "object" && body !== null &&
    "error" in body && typeof body.error === "string"
    ? body.error
    : fallback
  return failure(message, response.status >= 500 || response.status === 429)
}

const decodeResponse = <A, I>(
  schema: Schema.Schema<A, I>,
  value: unknown,
  message: string
): A => {
  try {
    return Schema.decodeUnknownSync(schema)(value, { onExcessProperty: "error" })
  } catch {
    throw failure(message)
  }
}

const requestJson = async (
  url: string,
  init: RequestInit,
  message: string
): Promise<unknown> => {
  let response: Response
  try {
    response = await fetch(url, init)
  } catch {
    throw failure(message, true)
  }
  if (!response.ok) throw await responseError(response, message)
  return response.json()
}

const terminal = (result: OffloadJobResult): OffloadedCommandResult => {
  if (result.state !== "succeeded" || result.exitCode === null) {
    const detail = result.stderr.trim() || result.stdout.trim()
    const reason = result.failureReason ?? result.state
    throw failure(
      `Remote command failed (${reason})${detail ? `: ${detail}` : ""}. ` +
      "It was not retried locally; only the operator can force a local retry by disabling Offload Compute first."
    )
  }
  return {
    command: "offloaded",
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    offloaded: true,
    jobId: result.jobId
  }
}

const reportEvents = (
  events: ReadonlyArray<OffloadJobEvent>,
  context: ToolExecutionContext
): void => {
  for (const event of events) {
    if (event.kind === "output") {
      context.progress({ message: event.text, completed: null, total: null })
    } else if (event.kind === "state") {
      context.progress({
        message: `Offload Compute: ${event.state}`,
        completed: null,
        total: null
      })
    }
  }
}

export const interruptibleDelay = (
  milliseconds: number,
  signal: AbortSignal
): Promise<void> =>
  new Promise((resolve, reject) => {
    let settled = false
    const finish = (result: "elapsed" | "aborted"): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal.removeEventListener("abort", onAbort)
      if (result === "elapsed") resolve()
      else reject(new ToolError("cancelled", "Remote command cancelled", true))
    }
    const onAbort = (): void => finish("aborted")
    const timeout = setTimeout(() => finish("elapsed"), milliseconds)
    signal.addEventListener("abort", onAbort, { once: true })
    if (signal.aborted) onAbort()
  })

interface PollInput {
  readonly admission: OffloadAdmissionResponse
  readonly refresh: () => Promise<OffloadAdmissionResponse>
  readonly context: ToolExecutionContext
  readonly deadlineAt: number
}

const cancelRemote = async (
  admission: OffloadAdmissionResponse
): Promise<void> => {
  await fetch(
    `${admission.runtimeUrl}/v1/offload/jobs/${encodeURIComponent(admission.jobId)}/cancel`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${admission.grant}` }
    }
  ).catch(() => undefined)
}

export const pollResult = async (input: PollInput): Promise<OffloadedCommandResult> => {
  let admission = input.admission
  let cursor = 0
  let consecutiveFailures = 0
  while (true) {
    if (Date.now() >= input.deadlineAt) {
      await cancelRemote(admission)
      throw failure("Remote job status deadline expired; it was not retried locally", true)
    }
    if (input.context.signal.aborted) {
      await cancelRemote(admission)
      throw new ToolError("cancelled", "Remote command cancelled", true)
    }
    const response = await fetch(
      `${admission.runtimeUrl}/v1/offload/jobs/${encodeURIComponent(admission.jobId)}/events?cursor=${cursor}`,
      { headers: { authorization: `Bearer ${admission.grant}` } }
    ).catch(() => null)
    if (response === null) {
      consecutiveFailures += 1
      await interruptibleDelay(
        Math.min(10_000, 500 * (2 ** Math.min(consecutiveFailures - 1, 5))),
        input.context.signal
      )
      continue
    }
    consecutiveFailures = 0
    if (response.status === 401 || response.status === 403) {
      admission = await input.refresh()
      continue
    }
    if (!response.ok) throw await responseError(response, "Remote job status unavailable")
    const page = decodeResponse(
      OffloadEventPage,
      await response.json(),
      "Remote job returned invalid status data"
    )
    cursor = page.cursor
    reportEvents(page.events, input.context)
    if (page.result !== null) return terminal(page.result)
    await interruptibleDelay(500, input.context.signal)
  }
}

/** Capture desktop services once; each command remains an Effect-owned workflow. */
export const makeOffloadCommandRouterWithOwnedDevice = (
  ownedDevice?: OwnedDeviceOffloadPort,
  resourcePressure: ResourcePressurePort = makeResourcePressureMonitor()
) => Effect.gen(function* () {
  const config = yield* ConfigService
  const secrets = yield* SecretStore
  const git = yield* GitService
  const fs = yield* FileSystem.FileSystem
  const paths = yield* AppPaths
  const executor = yield* CommandExecutor.CommandExecutor
  const closeConfig = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | AppPaths>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(AppPaths, paths)
    )
  const closeGit = <A, E>(effect: Effect.Effect<A, E, CommandExecutor.CommandExecutor>) =>
    effect.pipe(Effect.provideService(CommandExecutor.CommandExecutor, executor))

  const primeSession: OffloadCommandRouterPort["primeSession"] = (cwd, sessionId) =>
    Effect.gen(function* () {
      const settings = (yield* closeConfig(config.get()).pipe(
        Effect.mapError(() => failure("Could not read Offload Compute settings"))
      ))?.offloadCompute ?? DEFAULT_OFFLOAD_COMPUTE_SETTINGS
      if (!settings.enabled) return "disabled" as const
      resourcePressure.start()
      if (settings.target.kind === "owned-device") return "accepted" as const
      const token = yield* secrets.get
      if (token === null) return yield* Effect.fail(failure("Sign in before using Offload Compute"))
      const [remote, headSha] = yield* Effect.all([
        closeGit(git.remoteUrl(cwd)),
        closeGit(git.revision(cwd, "HEAD"))
      ]).pipe(Effect.mapError(() => failure("Offload Compute requires a GitHub origin")))
      const repository = remote ? parseGitHubRemote(remote) : null
      if (repository === null) {
        return yield* Effect.fail(failure("Offload Compute requires a GitHub origin"))
      }
      yield* Effect.tryPromise({
        try: () => requestJson(
          `${serverBaseUrl()}/api/offload/prime`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json"
            },
            body: JSON.stringify({
              version: OFFLOAD_COMPUTE_PROTOCOL_VERSION,
              sessionId: opaqueId("session", sessionId),
              repositorySlug: `${repository.owner}/${repository.repo}`,
              headSha
            })
          },
          "Offload Compute primer unavailable"
        ),
        catch: (cause) => cause instanceof ToolError ? cause : failure("Offload Compute primer failed")
      })
      return "accepted" as const
    })

  const destroySession: OffloadCommandRouterPort["destroySession"] = (sessionId) =>
    Effect.gen(function* () {
      const token = yield* secrets.get
      if (token === null) return
      yield* Effect.tryPromise({
        try: () => requestJson(
          `${serverBaseUrl()}/api/offload/sandboxes/destroy`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json"
            },
            body: JSON.stringify({
              version: OFFLOAD_COMPUTE_PROTOCOL_VERSION,
              sessionId: opaqueId("session", sessionId)
            })
          },
          "Offload Sandbox cleanup unavailable"
        ),
        catch: (cause) => cause instanceof ToolError ? cause : failure("Offload Sandbox cleanup failed")
      })
    })

  const executeIfEligible: OffloadCommandRouterPort["executeIfEligible"] = (
    cwd,
    sessionId,
    source,
    context
  ) => Effect.gen(function* () {
    const settings = (yield* closeConfig(config.get()).pipe(
      Effect.mapError(() => failure("Could not read Offload Compute settings"))
    ))?.offloadCompute ?? DEFAULT_OFFLOAD_COMPUTE_SETTINGS
    const observed = parseObservedAgentShellCommand(source)
    const routing = classifyOffloadCommand(settings, observed.command)
    if (routing.target === "local") return null
    resourcePressure.start()
    if (!resourcePressure.isSqueezed()) return null

    context.progress({ message: "Offload Compute: capturing", completed: null, total: null })
    const snapshotStarted = Date.now()
    const snapshot = yield* captureOffloadSnapshot(cwd).pipe(
      Effect.mapError((cause) => failure(cause.message))
    )
    const limits = {
      timeoutSeconds: OFFLOAD_TIMEOUT_MAX_SECONDS,
      snapshotBytes: snapshot.identity.bytes,
      outputBytes: OFFLOAD_OUTPUT_MAX_BYTES
    }
    if (settings.target.kind === "owned-device") {
      if (ownedDevice === undefined) {
        return yield* Effect.fail(failure(
          "The selected owned device is unavailable; Offload Compute did not fall back"
        ))
      }
      return yield* ownedDevice.execute({
        deviceId: settings.target.deviceId,
        jobId: opaqueId("request", context.idempotencyKey ?? source).replace(/^request_/u, "job_"),
        snapshot,
        command: routing.command,
        limits,
        context
      }).pipe(Effect.map((result) => ({ ...result, command: source })))
    }
    const remote = yield* closeGit(git.remoteUrl(cwd)).pipe(
      Effect.mapError(() => failure("Offload Compute requires a GitHub origin"))
    )
    const repository = remote ? parseGitHubRemote(remote) : null
    if (repository === null) {
      return yield* Effect.fail(failure("Offload Compute requires a GitHub origin"))
    }
    const token = yield* secrets.get
    if (token === null) {
      return yield* Effect.fail(failure("Sign in before using Offload Compute"))
    }
    const request: OffloadAdmissionRequest = {
      version: OFFLOAD_COMPUTE_PROTOCOL_VERSION,
      sessionId: opaqueId("session", sessionId),
      idempotencyKey: opaqueId("request", context.idempotencyKey ?? source),
      repositorySlug: `${repository.owner}/${repository.repo}`,
      snapshot: snapshot.identity,
      command: routing.command,
      clientTimings: { snapshotMs: Date.now() - snapshotStarted },
      limits
    }
    const admit = async (): Promise<OffloadAdmissionResponse> =>
      decodeResponse(
        OffloadAdmissionResponse,
        await requestJson(
          `${serverBaseUrl()}/api/offload/jobs`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json"
            },
            body: JSON.stringify(request)
          },
          "Offload Compute admission unavailable"
        ),
        "Offload Compute admission returned invalid data"
      )
    const admission = yield* Effect.tryPromise({
      try: admit,
      catch: (cause) => cause instanceof ToolError ? cause : failure("Offload Compute admission failed")
    })
    context.progress({ message: "Offload Compute: uploading", completed: 0, total: snapshot.compressedBytes.byteLength })
    const upload = (target: OffloadAdmissionResponse) => uploadOffloadSnapshot({
      url: target.uploadUrl,
      grant: target.grant,
      snapshot,
      onProgress: (completed, total) => context.progress({
        message: "Offload Compute: uploading",
        completed,
        total
      })
    }).pipe(Effect.as(target))
    const uploadedAdmission = yield* upload(admission).pipe(
      Effect.catchAll(() =>
        Effect.tryPromise({
          try: admit,
          catch: (cause) => cause instanceof ToolError
            ? cause
            : failure("Offload Compute upload grant refresh failed", true)
        }).pipe(Effect.flatMap(upload))
      ),
      Effect.mapError((cause) => failure(cause.message, true))
    )
    return yield* Effect.tryPromise({
      try: () => pollResult({
        admission: uploadedAdmission,
        refresh: admit,
        context,
        deadlineAt: Date.now() + (request.limits.timeoutSeconds + 35 * 60) * 1_000
      }),
      catch: (cause) => cause instanceof ToolError ? cause : failure("Remote command failed", true)
    }).pipe(
      Effect.map((result) => ({ ...result, command: source })),
      Effect.onInterrupt(() => Effect.promise(() => cancelRemote(admission)))
    )
  })

  return { primeSession, destroySession, executeIfEligible } satisfies OffloadCommandRouterPort
})

export const makeOffloadCommandRouter = makeOffloadCommandRouterWithOwnedDevice()
