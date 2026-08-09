import type { ManifestInput } from "./src/define.js"

/** Write a plugin's TypeScript manifest as the JSON document Jingler loads. */
export declare const emitManifest: (
  manifest: ManifestInput,
  pluginRoot: string | URL
) => string
