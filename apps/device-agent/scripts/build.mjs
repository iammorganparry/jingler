import { execFile } from "node:child_process"
import { chmod, cp, mkdir, open, readdir, readFile, rm } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { promisify } from "node:util"
import { build } from "esbuild"

const run = promisify(execFile)
const root = resolve(import.meta.dirname, "../../..")
const dist = resolve(import.meta.dirname, "../dist")
const payload = resolve(dist, "runtime-payload")
const notice = await readFile(resolve(root, "THIRD-PARTY-LICENSES"), "utf8")

await rm(dist, { recursive: true, force: true })
await mkdir(resolve(payload, "runtime-assets"), { recursive: true })

await build({
  entryPoints: [resolve(import.meta.dirname, "../src/index.ts")],
  bundle: true,
  platform: "node",
  mainFields: ["module", "main"],
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

await build({
  entryPoints: [resolve(root, "packages/cli-adapters/src/runtime/providers/claude-cli-extension.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  outfile: resolve(payload, "runtime-assets/jingler-claude-cli-provider.mjs")
})
await cp(
  resolve(root, "packages/cli-adapters/runtime-assets/jingler-child-tools.mjs"),
  resolve(payload, "runtime-assets/jingler-child-tools.mjs")
)

const packageRoots = [
  "@dietrichgebert/ponytail",
  "@jingler/plannotator-ext",
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
  const source = name === "@jingler/plannotator-ext"
    ? resolve(root, "packages/plannotator-ext")
    : resolve(root, "node_modules", name)
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
// The compatibility entry is executed beside dist/node_modules; the archive uses
// runtime-payload/node_modules. Keep both layouts runnable from the same build.
await cp(resolve(payload, "node_modules"), resolve(dist, "node_modules"), {
  recursive: true,
  dereference: true
})

// Apple notarization inspects inside the tarball: every Mach-O it finds must
// carry a Developer ID signature with hardened runtime and a secure timestamp,
// or the whole app is rejected. The release workflow imports the certificate
// and names it in JINGLER_CODESIGN_IDENTITY; everywhere else this is a no-op.
const MACH_O_MAGIC = new Set([0xfeedfacf, 0xcffaedfe, 0xfeedface, 0xcefaedfe, 0xcafebabe, 0xbebafeca])

const isMachO = async (path) => {
  const file = await open(path, "r")
  try {
    const { buffer, bytesRead } = await file.read(Buffer.alloc(4), 0, 4, 0)
    return bytesRead === 4 && MACH_O_MAGIC.has(buffer.readUInt32BE(0))
  } finally {
    await file.close()
  }
}

const identity = process.env.JINGLER_CODESIGN_IDENTITY
if (identity) {
  const entries = await readdir(payload, { recursive: true, withFileTypes: true })
  const files = entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name))
  const machO = await Promise.all(files.map(isMachO))
  const binaries = files.filter((_, index) => machO[index])
  await Promise.all(
    binaries.map((path) =>
      run("codesign", ["--force", "--timestamp", "--options", "runtime", "--sign", identity, path])
    )
  )
  for (const path of binaries) console.log(`signed ${path.slice(payload.length + 1)}`)
}

await run("tar", [
  "-czf",
  resolve(dist, "jingler-device-runtime.tgz"),
  "-C",
  payload,
  "."
])
