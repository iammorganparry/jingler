import { execFileSync, execSync } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
export const DESKTOP_ROOT = resolve(here, "..")
export const MAIN_ENTRY = resolve(DESKTOP_ROOT, "out/main/index.js")
const REPO_ROOT = resolve(DESKTOP_ROOT, "../..")
const GITHUB_ISSUES_PLUGIN_ROOT = resolve(REPO_ROOT, "plugins/github-issues")
const GITHUB_ISSUES_PLUGIN_ENTRIES = [
  resolve(GITHUB_ISSUES_PLUGIN_ROOT, "dist/ui.js"),
  resolve(GITHUB_ISSUES_PLUGIN_ROOT, "dist/main.js")
] as const

const buildBundledPlugins = (): void => {
  execFileSync("pnpm", ["--filter", "@jingler/plugin-github-issues", "build"], {
    cwd: REPO_ROOT,
    stdio: "inherit"
  })
}

/**
 * Build the Electron app once before the suite so specs can launch the real
 * bundled `out/main/index.js`. The development app loads official plugins from
 * the repository, whose ignored `dist/` output is absent in a clean worktree, so
 * build those before Electron too. Set `SKIP_E2E_BUILD=1` to reuse existing
 * outputs during fast local iteration.
 */
export default function globalSetup(): void {
  const reuseBuild = process.env.SKIP_E2E_BUILD === "1"
  if (!reuseBuild || GITHUB_ISSUES_PLUGIN_ENTRIES.some((entry) => !existsSync(entry))) {
    buildBundledPlugins()
  }
  if (reuseBuild && existsSync(MAIN_ENTRY)) {
    return
  }
  execSync("pnpm exec electron-vite build", { cwd: DESKTOP_ROOT, stdio: "inherit" })
}
