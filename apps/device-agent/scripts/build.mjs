import { execFile } from "node:child_process"
import { chmod, cp, mkdir, readFile, rm } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { promisify } from "node:util"
import { build } from "esbuild"

const run = promisify(execFile)
const root = resolve(import.meta.dirname, "../../..")
const dist = resolve(import.meta.dirname, "../dist")
const payload = resolve(dist, "runtime-payload")
const notice = await readFile(resolve(root, "THIRD-PARTY-LICENSES"), "utf8")

await rm(dist, { recursive: true, force: true })
await mkdir(payload, { recursive: true })

await build({
  entryPoints: [resolve(import.meta.dirname, "../src/index.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  outfile: resolve(payload, "jingler-device.mjs"),
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __jinglerCreateRequire } from \"node:module\"; const require = __jinglerCreateRequire(import.meta.url);"
  },
  footer: {
    js: `\n/*\n${notice.replaceAll("*/", "* /")}\n*/`
  }
})
await chmod(resolve(payload, "jingler-device.mjs"), 0o755)
// Cloud managed-runtime images still consume the standalone bundle directly;
// keep the compatibility copy while SSH bootstrap uses the full archive.
await cp(
  resolve(payload, "jingler-device.mjs"),
  resolve(dist, "jingler-device.mjs")
)
await chmod(resolve(dist, "jingler-device.mjs"), 0o755)

await mkdir(resolve(payload, "runtime-assets"), { recursive: true })
await cp(
  resolve(root, "packages/cli-adapters/runtime-assets/jingler-child-tools.mjs"),
  resolve(payload, "runtime-assets/jingler-child-tools.mjs")
)

const packageRoots = [
  "@dietrichgebert/ponytail",
  "pi-subagents",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui"
]
const copied = new Set()

const copyPackage = async (name) => {
  if (copied.has(name)) return
  copied.add(name)
  const source = resolve(root, "node_modules", name)
  const manifest = JSON.parse(await readFile(resolve(source, "package.json"), "utf8"))
  const destination = resolve(payload, "node_modules", name)
  await mkdir(dirname(destination), { recursive: true })
  await cp(source, destination, { recursive: true, dereference: true })
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    await copyPackage(dependency)
  }
  for (const dependency of Object.keys(manifest.optionalDependencies ?? {})) {
    try {
      await copyPackage(dependency)
    } catch (error) {
      if (error?.code !== "ENOENT") throw error
    }
  }
}

for (const name of packageRoots) await copyPackage(name)

await run("tar", [
  "-czf",
  resolve(dist, "jingler-device-runtime.tgz"),
  "-C",
  payload,
  "."
])
