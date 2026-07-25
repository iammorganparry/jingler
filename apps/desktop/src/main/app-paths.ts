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

/** The shared root for every Starbase-owned file in the desktop app. */
export const starbaseRoot = join(process.env.STARBASE_HOME ?? app.getPath("home"), "starbase")

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
  authFile: join(starbaseRoot, "auth.enc"),
  openConnectorFile: join(starbaseRoot, "open-connector.enc")
})
