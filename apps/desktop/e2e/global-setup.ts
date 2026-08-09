import { execFileSync, execSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
export const DESKTOP_ROOT = resolve(here, "..")
export const MAIN_ENTRY = resolve(DESKTOP_ROOT, "out/main/index.js")
const REPO_ROOT = resolve(DESKTOP_ROOT, "../..")
export const DEVICE_AGENT_ENTRY = resolve(REPO_ROOT, "apps/device-agent/dist/jingler-device.mjs")
const BUILDER_CONFIG = resolve(DESKTOP_ROOT, "electron-builder.yml")
const BUNDLED_PLUGIN_IDS = [
  ...readFileSync(BUILDER_CONFIG, "utf8").matchAll(/^\s*to:\s*plugins\/(\S+)\s*$/gm)
].flatMap((match) => (match[1] ? [match[1]] : []))
const BUNDLED_PLUGIN_ENTRIES = BUNDLED_PLUGIN_IDS.flatMap((id) => [
  resolve(REPO_ROOT, "plugins", id, "dist/ui.js"),
  resolve(REPO_ROOT, "plugins", id, "dist/main.js")
])

const buildBundledPlugins = (): void => {
  execFileSync("pnpm", ["--filter", "@jingler/desktop", "build:bundled-plugins"], {
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
  if (!reuseBuild || BUNDLED_PLUGIN_ENTRIES.some((entry) => !existsSync(entry))) {
    buildBundledPlugins()
  }
  if (reuseBuild && existsSync(MAIN_ENTRY)) {
    if (!existsSync(DEVICE_AGENT_ENTRY)) {
      execFileSync("pnpm", ["--filter", "@jingler/device-agent", "build"], {
        cwd: REPO_ROOT,
        stdio: "inherit"
      })
    }
    return
  }
  execFileSync("pnpm", ["--filter", "@jingler/device-agent", "build"], {
    cwd: REPO_ROOT,
    stdio: "inherit"
  })
  execSync("pnpm exec electron-vite build", { cwd: DESKTOP_ROOT, stdio: "inherit" })
}
