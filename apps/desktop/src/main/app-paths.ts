/**
 * Provides the concrete `~/starbase` paths for the backend services. The home
 * directory is resolved from Electron (`app.getPath("home")`), keeping the
 * environment-specific bit in the main process while `cli-adapters` stays
 * platform-agnostic behind the `AppPaths` tag.
 *
 * `STARBASE_HOME` overrides the home directory when set. It lets the Playwright
 * e2e suite point the whole app at a throwaway home dir (and is handy for dev),
 * without which every launch would read/write the developer's real `~/starbase`.
 */
import { join } from "node:path"
import { app } from "electron"
import { AppPaths } from "@starbase/cli-adapters"
import { Layer } from "effect"

/**
 * The shared root for every Starbase-owned file in the desktop app.
 *
 * Read once, at module load. That is fine for a running app — `STARBASE_HOME`
 * does not change under it — and the e2e suite launches a fresh process per
 * home, so nothing is pinned across the boundary that matters.
 */
export const starbaseRoot = join(process.env.STARBASE_HOME ?? app.getPath("home"), "starbase")

/**
 * Where installed plugins live.
 *
 * A function purely for call-site convenience — it derives from `starbaseRoot`,
 * which is itself resolved once at module load, so this is NOT lazier than a
 * const would be. An earlier version of this comment claimed it prevented
 * `STARBASE_HOME` being pinned; it does not, and nothing needs it to: each e2e
 * launch is its own process with its own environment.
 */
export const pluginsRoot = (): string => join(starbaseRoot, "plugins")

/**
 * Where the plugins that ship with Starbase live.
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
  root: starbaseRoot,
  configFile: join(starbaseRoot, "config.json"),
  sessionsFile: join(starbaseRoot, "sessions.json"),
  worktreesDir: join(starbaseRoot, "worktrees"),
  transcriptsDir: join(starbaseRoot, "transcripts"),
  reviewsDir: join(starbaseRoot, "reviews"),
  planRoundsDir: join(starbaseRoot, "plan-rounds"),
  plansDir: join(starbaseRoot, ".starbase"),
  themesDir: join(starbaseRoot, "themes"),
  pluginsDir: join(starbaseRoot, "plugins"),
  builtinPluginsDir: builtinPluginsRoot(),
  pluginStorageDir: join(starbaseRoot, "plugin-storage"),
  authFile: join(starbaseRoot, "auth.enc"),
  openConnectorFile: join(starbaseRoot, "open-connector.enc")
})
