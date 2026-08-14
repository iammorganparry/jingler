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
  makeOffloadCommandRouter,
  type OffloadCommandRouterPort
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

const router = async (): Promise<OffloadCommandRouterPort> => {
  const secrets = await Effect.runPromise(makeInMemorySecretStore("desktop-token"))
  return Effect.runPromise(
    makeOffloadCommandRouter.pipe(
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

  it("asynchronously primes an enabled session without capturing a snapshot", async () => {
    await writeFile(paths().configFile, JSON.stringify({
      reposDir: null,
      createdAt: new Date().toISOString(),
      offloadCompute: { enabled: true, explicitCommands: [] }
    }))
    fetchMock.mockResolvedValue(Response.json({ accepted: true }, { status: 202 }))
    await expect((await router()).primeSession(workspace, "session-one"))
      .resolves.toBe("accepted")
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      repositorySlug: string
      headSha: string
    }
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/offload/prime")
    expect(body.repositorySlug).toBe("jingler/example")
    expect(body.headSha).toMatch(/^[a-f0-9]{40}$/u)
  })

  it("captures, admits, uploads, and returns an eligible remote result", async () => {
    await writeFile(paths().configFile, JSON.stringify({
      reposDir: null,
      createdAt: new Date().toISOString(),
      offloadCompute: { enabled: true, explicitCommands: [] }
    }))
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input)
      if (url.endsWith("/api/offload/jobs")) return Response.json(admission)
      if (url.endsWith("/snapshot") && init?.method === "PUT") {
        return Response.json({ accepted: true }, { status: 202 })
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
  })
})
