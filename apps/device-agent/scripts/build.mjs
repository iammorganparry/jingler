import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { build } from "esbuild"

const root = resolve(import.meta.dirname, "../../..")
const notice = await readFile(resolve(root, "THIRD-PARTY-LICENSES"), "utf8")

await build({
  entryPoints: [resolve(import.meta.dirname, "../src/index.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  outfile: resolve(import.meta.dirname, "../dist/jingler-device.mjs"),
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __jinglerCreateRequire } from \"node:module\"; const require = __jinglerCreateRequire(import.meta.url);"
  },
  footer: {
    js: `\n/*\n${notice.replaceAll("*/", "* /")}\n*/`
  }
})
