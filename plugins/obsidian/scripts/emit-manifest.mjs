import { emitManifest } from "@jingler/plugin-sdk/emit-manifest"
import { manifest } from "../src/manifest.ts"

emitManifest(manifest, new URL("..", import.meta.url))
