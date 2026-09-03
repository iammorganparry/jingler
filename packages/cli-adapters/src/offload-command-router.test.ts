import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NodeContext } from "@effect/platform-node"
import {
  DEFAULT_OFFLOAD_COMPUTE_SETTINGS,
  OFFLOAD_COMPUTE_PROTOCOL_VERSION
} from "@jingler/core"
import { Effect, Layer } from "effect"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AppPaths, type AppPathsShape } from "./app-paths.js"
import { ConfigService } from "./config.js"
import { GitService } from "./git.js"
import {
  interruptibleDelay,
  makeOffloadCommandRouterWithOwnedDevice,
  pollResult,
  type OffloadCommandRouterPort,
  type OwnedDeviceOffloadPort
} from "./offload-command-router.js"
import {
  makeInMemorySecretStore,
  SecretStore
} from "./secret-store.js"
import type { ToolExecutionContext } from "./runtime/tools/tool-registry.js"

let root: string
let workspace: string
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>

const paths = (): AppPathsShape => ({
  root,
  configFile: join(root, "config.json"),
  mcpConfigFile: join(root, "mcp.json"),
  sessionsFile: join(root, "sessions.json"),
  projectsFile: join(root, "projects.json"),
  worktreesDir: join(root, "worktrees"),
  transcriptsDir: join(root, "transcripts"),
  reviewsDir: join(root, "reviews"),
  plansDir: join(root, "plans"),
  themesDir: join(root, "themes"),
  pluginsDir: join(root, "plugins"),
  pluginStorageDir: join(root, "plugin-storage"),
  authFile: join(root, "auth.enc"),
  openConnectorFile: join(root, "open-connector.enc"),
  deviceIdentityFile: join(root, "device-identity.json"),
  deviceSecretsFile: join(root, "device-secrets.json"),
  piSessionsDir: join(root, "pi-sessions"),
  managedResourcesDir: join(root, "managed-resources"),
  importedMcpFile: join(root, "imported-mcp.json"),
  certificationsFile: join(root, "certifications.json"),
  providerConnectionsFile: join(root, "provider-connections.json"),
  runJournalsDir: join(root, "run-journals"),
  diagnosticsDir: join(root, "diagnostics")
})

const router = async (
  squeezed = true,
  ownedDevice?: OwnedDeviceOffloadPort
): Promise<OffloadCommandRouterPort> => {
  const secrets = await Effect.runPromise(makeInMemorySecretStore("desktop-token"))
  return Effect.runPromise(
    makeOffloadCommandRouterWithOwnedDevice(ownedDevice, {
      start: () => undefined,
      isSqueezed: () => squeezed
    }).pipe(
      Effect.provide(ConfigService.Default),
      Effect.provide(GitService.Default),
      Effect.provide(Layer.succeed(SecretStore, secrets)),
      Effect.provide(Layer.succeed(AppPaths, paths())),
      Effect.provide(NodeContext.layer)
    )
  )
}

const context = (): ToolExecutionContext => ({
  signal: new AbortController().signal,
  idempotencyKey: "tool-call-one",
  progress: () => undefined
})

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jingler-offload-router-"))
  workspace = join(root, "workspace")
  await mkdir(workspace)
  execFileSync("git", ["init", "-q"], { cwd: workspace })
  execFileSync("git", ["config", "user.email", "test@jingler.dev"], { cwd: workspace })
  execFileSync("git", ["config", "user.name", "Jingler Test"], { cwd: workspace })
  await writeFile(join(workspace, "package.json"), "{}\n")
  execFileSync("git", ["add", "."], { cwd: workspace })
  execFileSync("git", ["commit", "-qm", "base"], { cwd: workspace })
  execFileSync("git", ["remote", "add", "origin", "https://github.com/jingler/example.git"], { cwd: workspace })
  fetchMock = vi.fn<typeof fetch>()
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await rm(root, { recursive: true, force: true })
})

const admission = {
  version: OFFLOAD_COMPUTE_PROTOCOL_VERSION,
  jobId: "job_aaaaaaaaaaaaaaaa",
  runtimeUrl: "https://runtime.test",
  uploadUrl: "https://runtime.test/v1/offload/jobs/job_aaaaaaaaaaaaaaaa/snapshot",
  grant: "grant_aaaaaaaaaaaaaaaa",
  expiresAt: Math.floor(Date.now() / 1_000) + 300
} as const

describe("interruptible offload polling delay", () => {
  it("removes its abort listener when a normal timeout elapses", async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const added = vi.spyOn(controller.signal, "addEventListener")
    const removed = vi.spyOn(controller.signal, "removeEventListener")

    const waiting = interruptibleDelay(500, controller.signal)
    await vi.advanceTimersByTimeAsync(500)
    await waiting

    const listener = added.mock.calls[0]?.[1]
    expect(listener).toBeDefined()
    expect(removed).toHaveBeenCalledWith("abort", listener)
    vi.useRealTimers()
  })

  it("removes its abort listener when cancellation wins", async () => {
    const controller = new AbortController()
    const removed = vi.spyOn(controller.signal, "removeEventListener")
    const waiting = interruptibleDelay(500, controller.signal)
    controller.abort()

    await expect(waiting).rejects.toMatchObject({ code: "cancelled" })
    expect(removed).toHaveBeenCalledOnce()
  })
})

describe("automatic Offload Compute routing", () => {
  it("keeps the local path untouched while disabled", async () => {
    await writeFile(paths().configFile, JSON.stringify({
      reposDir: null,
      createdAt: new Date().toISOString(),
      offloadCompute: DEFAULT_OFFLOAD_COMPUTE_SETTINGS
    }))
    const result = await Effect.runPromise(
      (await router()).executeIfEligible(
        workspace,
        "session-one",
        "pnpm typecheck",
        context()
      )
    )
    expect(result).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("keeps eligible work local while the host has CPU and memory headroom", async () => {
    await writeFile(paths().configFile, JSON.stringify({
      reposDir: null,
      createdAt: new Date().toISOString(),
      offloadCompute: { enabled: true, explicitCommands: [] }
    }))
    const result = await Effect.runPromise(
      (await router(false)).executeIfEligible(
        workspace,
        "session-one",
        "pnpm typecheck",
        context()
      )
    )
    expect(result).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("asynchronously primes an enabled session without capturing a snapshot", async () => {
    await writeFile(paths().configFile, JSON.stringify({
      reposDir: null,
      createdAt: new Date().toISOString(),
      offloadCompute: { enabled: true, explicitCommands: [] }
    }))
    fetchMock.mockResolvedValue(Response.json({ accepted: true }, { status: 202 }))
    await expect(Effect.runPromise(
      (await router()).primeSession(workspace, "session-one")
    )).resolves.toBe("accepted")
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      repositorySlug: string
      headSha: string
    }
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/offload/prime")
    expect(body.repositorySlug).toBe("jingler/example")
    expect(body.headSha).toMatch(/^[a-f0-9]{40}$/u)
  })

  it("fails and cancels polling after its lifecycle deadline", async () => {
    fetchMock.mockResolvedValue(Response.json({ cancelled: true }))
    await expect(pollResult({
      admission,
      refresh: async () => admission,
      context: context(),
      deadlineAt: Date.now() - 1
    })).rejects.toThrow("deadline expired")
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/cancel")
  })

  it("cancels with the latest refreshed grant", async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const refreshed = { ...admission, grant: "grant_bbbbbbbbbbbbbbbb" }
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValueOnce(Response.json({ cancelled: true }))
    const polling = pollResult({
      admission,
      refresh: async () => refreshed,
      onAdmission: () => controller.abort(),
      context: { ...context(), signal: controller.signal },
      deadlineAt: Date.now() + 60_000
    })
    const outcome = expect(polling).rejects.toMatchObject({ code: "cancelled" })
    await vi.runAllTimersAsync()
    await outcome
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toEqual({
      authorization: `Bearer ${refreshed.grant}`
    })
    vi.useRealTimers()
  })

  it("bounds repeated authorization refreshes with backoff", async () => {
    vi.useFakeTimers()
    fetchMock.mockResolvedValue(new Response(null, { status: 403 }))
    const refresh = vi.fn(async () => admission)
    const polling = pollResult({
      admission,
      refresh,
      context: context(),
      deadlineAt: Date.now() + 60_000
    })
    const outcome = expect(polling).rejects.toThrow("three grant refreshes")
    await vi.runAllTimersAsync()
    await outcome
    expect(refresh).toHaveBeenCalledTimes(3)
    expect(fetchMock).toHaveBeenCalledTimes(4)
    vi.useRealTimers()
  })

  it("rejects offload without a stable per-invocation identity", async () => {
    await writeFile(paths().configFile, JSON.stringify({
      reposDir: null,
      createdAt: new Date().toISOString(),
      offloadCompute: { enabled: true, explicitCommands: [] }
    }))
    await expect(Effect.runPromise(
      (await router()).executeIfEligible(
        workspace,
        "session-one",
        "pnpm typecheck",
        { ...context(), idempotencyKey: null }
      )
    )).rejects.toThrow("stable tool invocation identity")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("routes a pressured eligible command only to the selected owned device", async () => {
    await writeFile(paths().configFile, JSON.stringify({
      reposDir: null,
      createdAt: new Date().toISOString(),
      offloadCompute: {
        enabled: true,
        target: { kind: "owned-device", deviceId: "device_selected" },
        explicitCommands: []
      }
    }))
    const execute = vi.fn<OwnedDeviceOffloadPort["execute"]>(() => Effect.succeed({
      command: "pnpm typecheck",
      exitCode: 0,
      stdout: "owned device",
      stderr: "",
      offloaded: true,
      jobId: "job_abcdefghijklmnop"
    }))

    const result = await Effect.runPromise(
      (await router(true, { execute })).executeIfEligible(
        workspace,
        "session-one",
        "pnpm typecheck",
        context()
      )
    )

    expect(result?.stdout).toBe("owned device")
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      deviceId: "device_selected"
    }))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("fails closed when the selected owned-device transport is unavailable", async () => {
    await writeFile(paths().configFile, JSON.stringify({
      reposDir: null,
      createdAt: new Date().toISOString(),
      offloadCompute: {
        enabled: true,
        target: { kind: "owned-device", deviceId: "device_offline" },
        explicitCommands: []
      }
    }))

    await expect(Effect.runPromise(
      (await router()).executeIfEligible(workspace, "session-one", "pnpm typecheck", context())
    )).rejects.toThrow("did not fall back")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("refreshes an indeterminate upload and returns the eligible remote result", async () => {
    await writeFile(paths().configFile, JSON.stringify({
      reposDir: null,
      createdAt: new Date().toISOString(),
      offloadCompute: { enabled: true, explicitCommands: [] }
    }))
    let uploadAttempts = 0
    fetchMock.mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      const method = input instanceof Request ? input.method : init?.method
      if (url.endsWith("/api/offload/jobs")) return Response.json(admission)
      if (url.endsWith("/snapshot") && method === "PUT") {
        uploadAttempts += 1
        return uploadAttempts === 1
          ? Response.json({ error: "transient R2 failure" }, { status: 503 })
          : Response.json({ accepted: true }, { status: 202 })
      }
      if (url.includes("/events?cursor=0")) {
        return Response.json({
          version: 1,
          jobId: admission.jobId,
          state: "succeeded",
          cursor: 2,
          events: [{
            version: 1,
            jobId: admission.jobId,
            sequence: 1,
            kind: "state",
            state: "running"
          }, {
            version: 1,
            jobId: admission.jobId,
            sequence: 2,
            kind: "result",
            result: {
              version: 1,
              jobId: admission.jobId,
              state: "succeeded",
              exitCode: 0,
              failureReason: null,
              stdout: "remote clean",
              stderr: "",
              outputTruncated: false,
              timings: {
                queuedMs: 1,
                snapshotMs: 2,
                hydrationMs: 3,
                dependencyMs: 4,
                commandMs: 5
              }
            }
          }],
          result: {
            version: 1,
            jobId: admission.jobId,
            state: "succeeded",
            exitCode: 0,
            failureReason: null,
            stdout: "remote clean",
            stderr: "",
            outputTruncated: false,
            timings: {
              queuedMs: 1,
              snapshotMs: 2,
              hydrationMs: 3,
              dependencyMs: 4,
              commandMs: 5
            }
          }
        })
      }
      return Response.json({ error: "unexpected request" }, { status: 500 })
    })
    const result = await Effect.runPromise(
      (await router()).executeIfEligible(
        workspace,
        "session-one",
        "pnpm typecheck",
        context()
      )
    )
    expect(result).toMatchObject({
      offloaded: true,
      stdout: "remote clean",
      command: "pnpm typecheck"
    })
    const admissionCall = fetchMock.mock.calls.find(([input]) =>
      String(input).endsWith("/api/offload/jobs")
    )
    const requestBody = JSON.parse(String(admissionCall?.[1]?.body)) as {
      command: { executable: string; args: string[] }
    }
    expect(requestBody.command).toEqual(expect.objectContaining({
      executable: "pnpm",
      args: ["typecheck"]
    }))
    expect(uploadAttempts).toBe(2)
    expect(fetchMock.mock.calls.filter(([input]) =>
      String(input).endsWith("/api/offload/jobs")
    )).toHaveLength(2)
  })
})
