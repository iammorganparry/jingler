/**
 * Replace the pnpm workspace SYMLINK for @jingler/plannotator-ext with a real
 * directory copy before electron-builder runs.
 *
 * The forked Plannotator extension is the desktop's only workspace package in
 * `dependencies` — it must ship inside the asar as raw source, exactly like
 * the upstream npm package did, because pi loads it from disk at runtime and
 * Electron's asar-transparent fs resolves its own deps (parse5, the pi host
 * packages) from the packed node_modules. electron-builder, however, refuses
 * any dependency whose resolved path escapes apps/desktop ("<path> must be
 * under <appDir>"), which is exactly what a workspace symlink into
 * packages/plannotator-ext does. Materializing the copy keeps dev on the live
 * symlink (this script only runs in the dist flow; the next `pnpm install`
 * restores the link) while giving the packer a real in-tree directory.
 */
import { cpSync, lstatSync, rmSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const source = resolve(desktopRoot, "../../packages/plannotator-ext")
const target = join(desktopRoot, "node_modules", "@jingler", "plannotator-ext")

const stats = lstatSync(target, { throwIfNoEntry: false })
if (stats?.isSymbolicLink() || stats?.isDirectory()) {
  rmSync(target, { recursive: true, force: true })
}
cpSync(source, target, {
  recursive: true,
  dereference: true,
  filter: (candidate) => !candidate.includes(`${join(source, "node_modules")}`)
})
console.log(`Materialized ${source} -> ${target}`)
