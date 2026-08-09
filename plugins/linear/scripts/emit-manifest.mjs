import { copyFileSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { manifest } from "../src/manifest.ts"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const manifestPath = resolve(root, "jingler.plugin.json")
const assetDir = resolve(root, "dist/assets")

mkdirSync(assetDir, { recursive: true })
copyFileSync(resolve(root, "assets/linear-mark.svg"), resolve(assetDir, "linear-mark.svg"))
writeFileSync(
  manifestPath,
  `${JSON.stringify(
    { $schema: "../../packages/plugin-sdk/jingler.plugin.schema.json", ...manifest },
    null,
    2
  )}\n`,
  "utf8"
)
