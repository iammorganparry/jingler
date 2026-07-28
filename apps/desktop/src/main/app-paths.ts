/**
 * Provides the concrete `~/jingler` paths for the backend services. The home
 * directory is resolved from Electron (`app.getPath("home")`), keeping the
 * environment-specific bit in the main process while `cli-adapters` stays
 * platform-agnostic behind the `AppPaths` tag.
 *
 * `JINGLER_HOME` overrides the home directory when set. It lets the Playwright
 * e2e suite point the whole app at a throwaway home dir (and is handy for dev),
 * without which every launch would read/write the developer's real `~/jingler`.
 */
import { join } from "node:path"
import { app } from "electron"
import { AppPaths } from "@jingler/cli-adapters"
import { Layer } from "effect"

/**
 * The shared root for every Jingler-owned file in the desktop app.
 *
 * Read once, at module load. That is fine for a running app — `JINGLER_HOME`
 * does not change under it — and the e2e suite launches a fresh process per
 * home, so nothing is pinned across the boundary that matters.
 */
export const jinglerRoot = join(process.env.JINGLER_HOME ?? app.getPath("home"), "jingler")

/**
 * Where installed plugins live.
 *
 * A function purely for call-site convenience — it derives from `jinglerRoot`,
 * which is itself resolved once at module load, so this is NOT lazier than a
 * const would be. An earlier version of this comment claimed it prevented
 * `JINGLER_HOME` being pinned; it does not, and nothing needs it to: each e2e
 * launch is its own process with its own environment.
 */
export const pluginsRoot = (): string => join(jinglerRoot, "plugins")

/**
 * Where the plugins that ship with Jingler live.
 *
 * Packaged: `resources/plugins`, alongside the app's own asar. In development:
 * the repo's `plugins/` directory, so an official plugin under active edit is
 * the one the running app loads — the same live-reload story a third-party
 * author gets, rather than a build-and-copy step only we have to remember.
 *
 * A function for the same reason as `pluginsRoot` — call-site convenience, not
 * laziness. `app.isPackaged` is stable for the process's lifetime.
 */
export const builtinPluginsRoot = (): string =>
  app.isPackaged
    ? join(process.resourcesPath, "plugins")
    : join(import.meta.dirname, "../../../../plugins")

export const AppPathsLive = Layer.succeed(AppPaths, {
  root: jinglerRoot,
  configFile: join(jinglerRoot, "config.json"),
  sessionsFile: join(jinglerRoot, "sessions.json"),
  worktreesDir: join(jinglerRoot, "worktrees"),
  transcriptsDir: join(jinglerRoot, "transcripts"),
  reviewsDir: join(jinglerRoot, "reviews"),
  plansDir: join(jinglerRoot, ".jingler"),
  themesDir: join(jinglerRoot, "themes"),
  pluginsDir: join(jinglerRoot, "plugins"),
  builtinPluginsDir: builtinPluginsRoot(),
  pluginStorageDir: join(jinglerRoot, "plugin-storage"),
  authFile: join(jinglerRoot, "auth.enc"),
  openConnectorFile: join(jinglerRoot, "open-connector.enc")
})
