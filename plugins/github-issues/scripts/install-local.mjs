/**
 * Copy this plugin into `~/starbase/plugins/github-issues` so the running app picks
 * it up. Honours `STARBASE_HOME`, so it can target a throwaway home in tests.
 *
 * Copies rather than symlinks: the protocol handler resolves every request
 * through `realpath` and refuses anything landing outside the plugins root, so a
 * symlinked plugin directory would be served exactly zero files. That is the
 * guard working as intended — this script just has to respect it.
 */
import { cp, mkdir, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const src = fileURLToPath(new URL("..", import.meta.url))
const root = join(process.env.STARBASE_HOME ?? homedir(), "starbase", "plugins")
const dest = join(root, "github-issues")

await mkdir(root, { recursive: true })
await rm(dest, { recursive: true, force: true })
await mkdir(dest, { recursive: true })

for (const entry of ["starbase.plugin.json", "dist"]) {
  await cp(join(src, entry), join(dest, entry), { recursive: true })
}

console.log(`Installed github-issues to ${dest}`)
console.log("The app picks it up live — no restart needed.")
