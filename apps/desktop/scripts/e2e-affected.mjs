// Runs only the e2e specs a change can affect. Selection logic: e2e-affected-select.js.
// Usage: pnpm --filter @jingler/desktop e2e:affected [--base <ref>] [--list] [playwright args]
import { execFileSync, spawn } from "node:child_process"
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { selectSpecs } from "./e2e-affected-select.js"
import { normalizeE2eArgs } from "./run-e2e-args.js"

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), "..")
const e2eDir = join(desktopDir, "e2e")
const git = (...args) => execFileSync("git", args, { cwd: desktopDir, encoding: "utf8" }).split("\n").filter(Boolean)

const args = normalizeE2eArgs(process.argv.slice(2))
const baseAt = args.indexOf("--base")
const base = baseAt === -1 ? "origin/epic/redesign" : args[baseAt + 1]
const listOnly = args.includes("--list")
const passthrough = args.filter((arg, i) => arg !== "--list" && arg !== "--base" && (baseAt === -1 || i !== baseAt + 1))

const allSpecs = readdirSync(e2eDir).filter((name) => name.endsWith(".spec.ts")).sort()
const map = JSON.parse(readFileSync(join(e2eDir, "affected-map.json"), "utf8"))

// `--relative=` is not used: git prints repo-root paths with --full-name, which the map expects.
const changedFiles = () => {
  const mergeBase = git("merge-base", base, "HEAD")[0]
  return [...new Set([...git("diff", "--name-only", "--full-name", mergeBase), ...git("ls-files", "--others", "--exclude-standard", "--full-name")])]
}

let selection
try {
  selection = selectSpecs(changedFiles(), map, allSpecs)
} catch (error) {
  selection = { specs: allSpecs, reason: [`running every spec: could not diff against ${base} (${error.message.split("\n")[0]})`] }
}

console.log(`e2e:affected — ${selection.specs.length}/${allSpecs.length} specs (base ${base})`)
for (const line of selection.reason) console.log(`  ${line}`)
for (const name of selection.specs) console.log(`  → ${name}`)

if (selection.specs.length === 0) {
  console.log("No e2e specs affected; nothing to run.")
  process.exit(0)
}
if (listOnly) process.exit(0)

const everything = selection.specs.length === allSpecs.length
const filters = everything ? [] : selection.specs.map((name) => `e2e/${name}`)
const child = spawn("node", [join(desktopDir, "scripts/run-e2e.mjs"), ...filters, ...passthrough], { cwd: desktopDir, stdio: "inherit" })
child.on("exit", (code) => process.exit(code ?? 1))
