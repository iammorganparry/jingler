import { emitManifest } from "@jingler/plugin-sdk/emit-manifest"
import { fileURLToPath } from "node:url"
import { manifest } from "../src/manifest.ts"

emitManifest(manifest, fileURLToPath(new URL("..", import.meta.url)))
