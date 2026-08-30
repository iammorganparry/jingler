import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { expect, it } from "vitest"

/**
 * Guards the renderer's Pierre dependency wiring in electron.vite.config.ts.
 *
 * With the hoisted node-linker the repo root holds whatever @pierre/diffs
 * version hoisting won (the Plannotator extension pins its own), and Vite
 * resolves `optimizeDeps.include` entries from the renderer root while imports
 * inside packages/ui resolve to its nested copy. Two copies split
 * @pierre/diffs' themeResolver singleton: the Jingler theme registered through
 * the bare entry is invisible to the /react components, every highlight
 * rejects with "No valid theme loader registered", and the file view renders
 * blank — in dev only, because the production Rollup build resolves the whole
 * graph importer-relative. The contract these tests pin: apps/desktop declares
 * the @pierre packages at the exact versions packages/ui pins, the renderer
 * dedupes them onto that single copy, every imported entrypoint is
 * pre-bundled, and the worker ships from the same install.
 */

const configPath = resolve(import.meta.dirname, "electron.vite.config.ts")
const repoRoot = resolve(import.meta.dirname, "../..")

const sourceRoots = [
  join(repoRoot, "packages/ui/src"),
  resolve(import.meta.dirname, "src/renderer")
]

const TYPESCRIPT_SOURCE = /\.(ts|tsx)$/
const PIERRE_IMPORT = /from\s+"(@pierre\/[^"]+)"/g
const OPTIMIZE_DEPS_INCLUDE = /optimizeDeps:\s*\{[^}]*include:\s*\[([^\]]*)\]/
const RESOLVE_DEDUPE = /dedupe:\s*\[([^\]]*)\]/
const QUOTED_ENTRY = /"([^"]+)"/g
const PIERRE_PACKAGE = /^(@pierre\/[^/]+)/

const dependencyVersions = (packagePath: string): Record<string, string> =>
  (
    JSON.parse(readFileSync(packagePath, "utf-8")) as {
      dependencies: Record<string, string>
    }
  ).dependencies

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return TYPESCRIPT_SOURCE.test(name) ? [path] : []
  })

const importedPierreEntrypoints = (): Set<string> => {
  const entrypoints = new Set<string>()
  for (const root of sourceRoots) {
    for (const file of sourceFiles(root)) {
      const source = readFileSync(file, "utf-8")
      for (const match of source.matchAll(PIERRE_IMPORT)) {
        entrypoints.add(match[1]!)
      }
    }
  }
  return entrypoints
}

const configList = (pattern: RegExp, label: string): string[] => {
  const config = readFileSync(configPath, "utf-8")
  const match = config.match(pattern)
  expect(match, `${label} in electron.vite.config.ts`).not.toBeNull()
  return [...match![1]!.matchAll(QUOTED_ENTRY)].map((m) => m[1]!)
}

it("pre-bundles and dedupes every @pierre package the renderer graph imports", () => {
  const include = new Set(
    configList(OPTIMIZE_DEPS_INCLUDE, "renderer optimizeDeps.include")
  )
  const dedupe = new Set(configList(RESOLVE_DEDUPE, "renderer resolve.dedupe"))
  for (const entrypoint of importedPierreEntrypoints()) {
    expect(
      include,
      `${entrypoint} is imported by renderer sources but missing from ` +
        "optimizeDeps.include — the dev optimizer would discover it " +
        "mid-session and force a re-optimization reload"
    ).toContain(entrypoint)
    const packageName = entrypoint.match(PIERRE_PACKAGE)![1]!
    expect(
      dedupe,
      `${packageName} is imported by renderer sources but missing from ` +
        "resolve.dedupe — packages/ui's nested copy and the renderer root " +
        "copy would load as separate modules and split @pierre singletons " +
        "(the themeResolver split renders the file view blank in dev)"
    ).toContain(packageName)
  }
})

it("declares the deduped @pierre packages at the versions packages/ui pins", () => {
  // resolve.dedupe resolves from the renderer root, so apps/desktop must own
  // direct deps at exactly the versions packages/ui uses — otherwise dedupe
  // would pin the whole renderer to whichever version the root hoisted.
  const desktop = dependencyVersions(
    resolve(import.meta.dirname, "package.json")
  )
  const ui = dependencyVersions(join(repoRoot, "packages/ui/package.json"))
  for (const name of configList(RESOLVE_DEDUPE, "renderer resolve.dedupe")) {
    if (!name.startsWith("@pierre/")) continue
    expect(desktop[name], `apps/desktop dependency on ${name}`).toBe(ui[name])
  }
})

it("ships the diffs worker from the app's own @pierre/diffs at packages/ui's version", () => {
  // Replicate the config's walk-up resolution: the worker must come from
  // the copy Node would resolve for apps/desktop (its direct dependency,
  // wherever the hoisted linker placed it), never a hard-coded install of a
  // different version (the Plannotator extension pins its own).
  const config = readFileSync(configPath, "utf-8")
  expect(config).not.toContain("../../node_modules/@pierre/diffs")

  let workerEntry: string | undefined
  for (
    let dir = import.meta.dirname, parent = "";
    parent !== dir;
    parent = dir, dir = resolve(dir, "..")
  ) {
    const candidate = join(dir, "node_modules/@pierre/diffs/dist/worker/worker.js")
    if (existsSync(candidate)) {
      workerEntry = candidate
      break
    }
  }
  expect(workerEntry, "@pierre/diffs worker.js reachable from apps/desktop").toBeDefined()
  expect(statSync(workerEntry!).isFile()).toBe(true)
  const workerPackage = JSON.parse(
    readFileSync(join(dirname(workerEntry!), "../../package.json"), "utf-8")
  ) as { name: string; version: string }
  const uiDeclared = dependencyVersions(
    join(repoRoot, "packages/ui/package.json")
  )["@pierre/diffs"]

  expect(workerPackage.name).toBe("@pierre/diffs")
  expect(workerPackage.version).toBe(uiDeclared)
})
