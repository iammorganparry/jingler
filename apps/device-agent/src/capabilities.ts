import { probeOpenCodeEndpoint } from "@jingler/cli-adapters/runtime/opencode/endpoint"
import { probeCodexEndpoint } from "@jingler/cli-adapters/runtime/codex/endpoint"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { homedir, arch, platform } from "node:os"
import { join } from "node:path"
import { NodeContext } from "@effect/platform-node"
import { AppPaths } from "@jingler/cli-adapters/app-paths"
import { makeAppPaths } from "@jingler/cli-adapters/app-paths-factory"
import { ConfigService } from "@jingler/cli-adapters/config"
import { WorkspaceService } from "@jingler/cli-adapters/workspace"
import { ProviderConnections } from "@jingler/cli-adapters/runtime/providers/provider-connections"
import { projectPiEndpointCatalog } from "@jingler/cli-adapters/runtime/providers/agent-endpoint-catalog"
import { probeClaudeEndpoint } from "@jingler/cli-adapters/runtime/providers/claude-endpoint"
import type {
  AgentEndpointCatalog,
  ProviderConnection,
  RemoteDeviceDiscovery,
  RemoteRepositoryCapability,
  Repo
} from "@jingler/core"
import { CURRENT_RUNTIME_CONTRACTS } from "@jingler/core"
import { Effect, Layer } from "effect"
import { loadDeviceE2ePiRuntime } from "./e2e/pi-runtime.js"
import { makeDeviceProviderLayers } from "./provider-runtime.js"

export interface CapabilitySources {
  readonly repositories: () => Effect.Effect<ReadonlyArray<Repo>, unknown>
  readonly branches: (repoPath: string) => Effect.Effect<ReadonlyArray<string>, unknown>
  readonly providerConnections?: () => Effect.Effect<ReadonlyArray<ProviderConnection>, unknown>
  readonly endpointCatalog?: () => Effect.Effect<AgentEndpointCatalog, unknown>
  readonly platform: () => { readonly os: string; readonly arch: string }
}

/** Seed a fresh headless install from conventional checkout roots. */
export const ensureDeviceWorkspaceConfig = async (
  jinglerRoot: string,
  home = homedir(),
  configuredReposDir = process.env.JINGLER_REPOS_DIR
): Promise<void> => {
  const configFile = join(jinglerRoot, "config.json")
  try {
    await readFile(configFile)
    return
  } catch {
    // A missing config is the fresh-device case. Never replace an existing file.
  }
  const candidates = [
    ...(configuredReposDir ? [configuredReposDir] : []),
    join(home, "repos"),
    join(home, "Developer"),
    join(home, "Projects")
  ]
  let reposDir: string | null = null
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isDirectory()) {
        reposDir = candidate
        break
      }
    } catch {
      // Try the next conventional root.
    }
  }
  if (!reposDir) return
  await mkdir(jinglerRoot, { recursive: true, mode: 0o700 })
  await writeFile(
    configFile,
    `${JSON.stringify({ reposDir, createdAt: new Date().toISOString() }, null, 2)}\n`,
    { mode: 0o600, flag: "wx" }
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error
  })
}

export const discoverDeviceCapabilities = (
  sources: CapabilitySources,
  agentVersion: string,
  targetId = "device"
): Effect.Effect<RemoteDeviceDiscovery> =>
  Effect.gen(function* () {
    const repositories = yield* sources.repositories().pipe(Effect.orElseSucceed(() => []))
    const providerConnections = yield* (sources.providerConnections?.() ?? Effect.succeed([])).pipe(
      Effect.orElseSucceed(() => [])
    )
    const endpointCatalog = yield* (sources.endpointCatalog?.() ?? Effect.succeed({
      endpoints: [],
      refreshedAt: new Date().toISOString(),
      stale: false
    })).pipe(
      Effect.orElseSucceed(() => ({
        endpoints: [],
        refreshedAt: new Date().toISOString(),
        stale: true
      }))
    )
    const remoteRepositories = yield* Effect.forEach(
      repositories.slice(0, 1_024),
      (repository): Effect.Effect<RemoteRepositoryCapability> =>
        sources.branches(repository.path).pipe(
          Effect.orElseSucceed(() => []),
          Effect.map((branches) => ({
            name: repository.name,
            path: repository.path,
            defaultBranch: repository.defaultBranch,
            currentBranch: repository.currentBranch,
            branches: branches.slice(0, 2_048),
            githubSlug: repository.githubSlug
          }))
        ),
      { concurrency: 8 }
    )
    return {
      version: 1,
      agentVersion,
      platform: sources.platform(),
      capabilities: {
        version: 1,
        capabilities: [
          "session.start",
          "session.input",
          "session.cancel",
          "session.observe",
          "project.manage"
        ],
        maxConcurrentSessions: 4,
        runtime: {
          versions: CURRENT_RUNTIME_CONTRACTS,
          toolIds: [],
          resourceIds: [],
          targetId
        },
        endpointCatalog,
        providerConnections: providerConnections.map((connection) => ({
          id: connection.id,
          providerId: connection.providerId,
          authKind: connection.authKind,
          status: connection.status
        }))
      },
      repositories: remoteRepositories.filter(
        (repository) =>
          repository.defaultBranch !== "HEAD" && repository.branches.length > 0
      )
    }
  })

/** Live discovery deliberately reuses the same host services as Electron main. */
export const discoverLiveDeviceCapabilities = (
  jinglerRoot: string,
  agentVersion: string,
  targetId = "device"
): Effect.Effect<RemoteDeviceDiscovery> => {
  const e2eRuntime = loadDeviceE2ePiRuntime(targetId)
  const deviceProviders = makeDeviceProviderLayers(
    targetId,
    process.env,
    e2eRuntime?.providers
  )
  const layer = Layer.mergeAll(
    WorkspaceService.Default,
    ConfigService.Default,
    NodeContext.layer,
    Layer.succeed(AppPaths, makeAppPaths(jinglerRoot))
  )
  return Effect.promise(() => ensureDeviceWorkspaceConfig(jinglerRoot)).pipe(
    Effect.flatMap(() =>
      discoverDeviceCapabilities(
        {
          repositories: () => WorkspaceService.listRepos().pipe(Effect.provide(layer)),
          branches: (repoPath) =>
            WorkspaceService.branches(repoPath).pipe(Effect.provide(layer)),
          providerConnections: () => Effect.succeed(deviceProviders.connections),
          endpointCatalog: () => Effect.gen(function* () {
            const pi = yield* ProviderConnections.pipe(
              Effect.flatMap((service) => service.list),
              Effect.map(projectPiEndpointCatalog),
              Effect.provide(deviceProviders.ProviderConnectionsLive),
              Effect.provide(deviceProviders.SecretStoreLive),
              Effect.provide(layer)
            )
            const claude = yield* Effect.promise(() =>
              probeClaudeEndpoint({ targetId })
            )
            return {
              ...pi,
              refreshedAt: new Date().toISOString(),
              endpoints: [...pi.endpoints.slice(0, 61), claude, yield* Effect.promise(() => probeCodexEndpoint({ targetId })), yield* Effect.promise(() => probeOpenCodeEndpoint({ targetId: targetId }))]
            }
          }),
          platform: () => ({ os: platform(), arch: arch() })
        },
        agentVersion,
        targetId
      )
    )
  )
}
