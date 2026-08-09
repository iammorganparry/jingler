import { emitManifest } from "@jingler/plugin-sdk/emit-manifest"
import { copyFileSync, mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { manifest } from "../src/manifest.ts"

const root = fileURLToPath(new URL("..", import.meta.url))
const assetDir = resolve(root, "dist/assets")

mkdirSync(assetDir, { recursive: true })
copyFileSync(resolve(root, "assets/linear-mark.svg"), resolve(assetDir, "linear-mark.svg"))
emitManifest(manifest, root)
