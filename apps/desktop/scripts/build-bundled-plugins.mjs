#!/usr/bin/env node
/**
 * Build the plugins that ship inside the app, and refuse to package without them.
 *
 * ## Why this exists rather than a line in the build script
 *
 * `electron-builder.yml` stages each plugin's `dist` into `resources/plugins`.
 * Three facts conspire to make that silently ship nothing:
 *
 *   1. every plugin's `dist` is git-ignored, so a fresh CI checkout has none;
 *   2. the release job builds with `--filter @starbase/desktop`, and the desktop
 *      app does not depend on any plugin, so no plugin build is pulled in;
 *   3. electron-builder treats a `filter` that matches nothing as success.
 *
 * The result was a `.dmg` containing `starbase.plugin.json` and no `dist/`. At
 * runtime `firstMissingEntry` files that under `entry-missing`, so the GitHub
 * Issues tab is simply absent — no crash, no error, nothing to search for.
 *
 * A build step alone would fix the common case and leave the silent one. This
 * script also VERIFIES, after building, that every entry each manifest names is
 * a real file, and exits non-zero if not. Shipping no plugins is now a failed
 * release rather than a quiet one.
 *
 * ## Why the plugin list is read out of electron-builder.yml
 *
 * It is the file that decides what ships. A second hand-maintained list here
 * would drift, and the drift is invisible in exactly the direction that hurts:
 * a plugin added to the YAML but not to the list gets staged unbuilt.
 */
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const desktopDir = resolve(here, "..")
const repoRoot = resolve(desktopDir, "../..")
const builderYml = join(desktopDir, "electron-builder.yml")
const isWindows = process.platform === "win32"

/**
 * The bundled plugin ids, read from the `to: plugins/<id>` lines of the
 * `extraResources` block. A regex rather than a YAML parser so this script has
 * no dependencies and can run before anything is installed.
 */
const ids = [...readFileSync(builderYml, "utf8").matchAll(/^\s*to:\s*plugins\/(\S+)\s*$/gm)].map(
  (match) => match[1]
)

if (ids.length === 0) {
  console.error(
    `No bundled plugins found in ${builderYml}.\n` +
      "Expected one or more `to: plugins/<id>` entries under `extraResources`.\n" +
      "If bundling a plugin was deliberately removed, delete this script and its\n" +
      "callers in package.json too, so nothing claims to enforce a rule that is gone."
  )
  process.exit(1)
}

console.log(`Building ${ids.length} bundled plugin(s): ${ids.join(", ")}`)

for (const id of ids) {
  const dir = join(repoRoot, "plugins", id)
  if (!existsSync(dir)) {
    console.error(
      `electron-builder.yml stages plugins/${id}, but ${dir} does not exist.\n` +
        "Either the plugin was moved and the YAML was not updated, or the id is a typo."
    )
    process.exit(1)
  }

  // `pnpm -C` rather than `--filter`: the package NAME and the directory name
  // differ (`@starbase/plugin-github-issues` lives at `plugins/github-issues`),
  // and the directory is what the YAML gives us.
  //
  // `shell: true` on Windows only. `pnpm` there is `pnpm.cmd`, and since the
  // fix for CVE-2024-27980 Node refuses to run a `.cmd`/`.bat` through
  // `execFile` without a shell — so the unshelled call is a flat ENOENT. The
  // release runner is macOS, but `electron-builder.yml` declares a `win`
  // target and this script is wired into `dist`/`electron:pack`, which a
  // developer on Windows runs directly. `dir` is quoted because a shell splits
  // on the spaces in a path like `C:\Users\Some One\starbase`.
  execFileSync(
    "pnpm",
    isWindows ? ["-C", `"${dir}"`, "run", "build"] : ["-C", dir, "run", "build"],
    { stdio: "inherit", cwd: repoRoot, shell: isWindows }
  )
}

// ── Verify, don't assume ─────────────────────────────────────────────────────
//
// The build succeeding is not the same as the files the manifest names existing:
// a plugin can build a `main.js` while its manifest still points at `index.js`.
// The app checks this at load time and reports `entry-missing` in Settings —
// which nobody reads before cutting a release.
const problems = []

for (const id of ids) {
  const dir = join(repoRoot, "plugins", id)
  const manifestPath = join(dir, "starbase.plugin.json")

  if (!existsSync(manifestPath)) {
    problems.push(`plugins/${id}: no starbase.plugin.json (does \`build\` run emit-manifest?)`)
    continue
  }

  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
  } catch (cause) {
    problems.push(`plugins/${id}: starbase.plugin.json is not valid JSON — ${cause.message}`)
    continue
  }

  // The directory name must equal the manifest id: discovery reads directory
  // names, and `PluginRegistry.dirFor` resolves `<root>/<id>`. A mismatch loads
  // the plugin but makes Reveal open a path it is not at.
  if (manifest.id !== id) {
    problems.push(
      `plugins/${id}: manifest id is "${manifest.id}" but it is staged as "plugins/${id}". ` +
        "The directory name and the manifest id must match."
    )
  }

  for (const field of ["ui", "main"]) {
    const entry = manifest[field]
    if (entry === undefined) continue // both are optional; a host-only plugin has no `ui`.
    if (!existsSync(join(dir, entry))) {
      problems.push(
        `plugins/${id}: manifest ${field} is "${entry}" but plugins/${id}/${entry} does not exist.`
      )
    }
  }
}

if (problems.length > 0) {
  console.error(
    `\nRefusing to package — ${problems.length} bundled plugin problem(s):\n` +
      problems.map((p) => `  • ${p}`).join("\n") +
      "\n\nThese would ship as an app whose official plugins are silently missing.\n"
  )
  process.exit(1)
}

console.log(`Bundled plugins OK: ${ids.join(", ")}`)
