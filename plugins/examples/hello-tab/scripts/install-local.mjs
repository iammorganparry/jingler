/**
 * Copy this plugin into `~/jingler/plugins/hello-tab` so the running app picks
 * it up. Honours `JINGLER_HOME`, so it can target a throwaway home in tests.
 *
 * Duplicated on purpose — see the long note in
 * `plugins/github-issues/scripts/install-local.mjs`. Change one, change all three
 * (here, github-issues, and the scaffold template in
 * `scripts/create-jingler-plugin.mjs`).
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
const root = join(process.env.JINGLER_HOME ?? homedir(), "jingler", "plugins")
const dest = join(root, "hello-tab")

await mkdir(root, { recursive: true })
await rm(dest, { recursive: true, force: true })
await mkdir(dest, { recursive: true })

for (const entry of ["jingler.plugin.json", "dist"]) {
  await cp(join(src, entry), join(dest, entry), { recursive: true })
}

console.log(`Installed hello-tab to ${dest}`)
console.log("The app picks it up live — no restart needed.")
