import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { homedir, arch, platform } from "node:os"
import { join } from "node:path"
import { NodeContext } from "@effect/platform-node"
import { AppPaths, type AppPathsShape } from "@jingler/cli-adapters/app-paths"
import { ConfigService } from "@jingler/cli-adapters/config"
import { DiscoveryService } from "@jingler/cli-adapters/discovery"
import { WorkspaceService } from "@jingler/cli-adapters/workspace"
import type {
  CliInfo,
  RemoteDeviceDiscovery,
  RemoteRepositoryCapability,
  Repo
} from "@jingler/core"
import { Effect, Layer } from "effect"

export interface CapabilitySources {
  readonly harnesses: () => Effect.Effect<ReadonlyArray<CliInfo>, unknown>
  readonly repositories: () => Effect.Effect<ReadonlyArray<Repo>, unknown>
  readonly branches: (repoPath: string) => Effect.Effect<ReadonlyArray<string>, unknown>
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
  agentVersion: string
): Effect.Effect<RemoteDeviceDiscovery> =>
  Effect.gen(function* () {
    const harnesses = yield* sources.harnesses().pipe(Effect.orElseSucceed(() => []))
    const repositories = yield* sources.repositories().pipe(Effect.orElseSucceed(() => []))
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
        capabilities: ["session.start", "session.input", "session.cancel", "session.observe"],
        harnesses: harnesses.filter((item) => item.available).map((item) => item.kind),
        maxConcurrentSessions: 4
      },
      repositories: remoteRepositories.filter(
        (repository) =>
          repository.defaultBranch !== "HEAD" && repository.branches.length > 0
      )
    }
  })

const appPaths = (root: string): AppPathsShape => ({
  root,
  configFile: join(root, "config.json"),
  sessionsFile: join(root, "sessions.json"),
  worktreesDir: join(root, "worktrees"),
  transcriptsDir: join(root, "transcripts"),
  reviewsDir: join(root, "reviews"),
  plansDir: join(root, ".jingler"),
  themesDir: join(root, "themes"),
  pluginsDir: join(root, "plugins"),
  pluginStorageDir: join(root, "plugin-storage"),
  authFile: join(root, "auth.enc"),
  openConnectorFile: join(root, "open-connector.enc")
})

/** Live discovery deliberately reuses the same host services as Electron main. */
export const discoverLiveDeviceCapabilities = (
  jinglerRoot: string,
  agentVersion: string
): Effect.Effect<RemoteDeviceDiscovery> => {
  const layer = Layer.mergeAll(
    DiscoveryService.Default,
    WorkspaceService.Default,
    ConfigService.Default,
    NodeContext.layer,
    Layer.succeed(AppPaths, appPaths(jinglerRoot))
  )
  return Effect.promise(() => ensureDeviceWorkspaceConfig(jinglerRoot)).pipe(
    Effect.flatMap(() =>
      discoverDeviceCapabilities(
        {
          harnesses: () => DiscoveryService.list().pipe(Effect.provide(layer)),
          repositories: () => WorkspaceService.listRepos().pipe(Effect.provide(layer)),
          branches: (repoPath) =>
            WorkspaceService.branches(repoPath).pipe(Effect.provide(layer)),
          platform: () => ({ os: platform(), arch: arch() })
        },
        agentVersion
      )
    )
  )
}
