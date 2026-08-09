import { writeFileSync } from "node:fs"
import { relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

const schemaPath = fileURLToPath(new URL("./jingler.plugin.schema.json", import.meta.url))

const filesystemPath = (path) => path instanceof URL ? fileURLToPath(path) : path
const portablePath = (path) => path.split(sep).join("/")

/** Write a plugin's TypeScript manifest as the JSON document Jingler loads. */
export const emitManifest = (manifest, pluginRoot) => {
  const root = filesystemPath(pluginRoot)
  const outputPath = resolve(root, "jingler.plugin.json")
  const output = {
    $schema: portablePath(relative(root, schemaPath)),
    ...manifest
  }
  writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8")
  console.log(`Wrote ${outputPath}`)
  return outputPath
}
