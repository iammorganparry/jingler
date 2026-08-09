import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { emitManifest } from "@jingler/plugin-sdk/emit-manifest"
import { afterEach, describe, expect, it } from "vitest"

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe("emitManifest", () => {
  it("writes formatted JSON with a schema path relative to the plugin", () => {
    const pluginRoot = mkdtempSync(resolve(tmpdir(), "jingler-plugin-manifest-"))
    temporaryDirectories.push(pluginRoot)

    const outputPath = emitManifest({
      id: "example",
      name: "Example",
      version: "1.0.0"
    }, pluginRoot)
    const source = readFileSync(outputPath, "utf8")
    const output = JSON.parse(source)

    expect(source.endsWith("\n")).toBe(true)
    expect(output).toMatchObject({ id: "example", name: "Example", version: "1.0.0" })
    expect(resolve(pluginRoot, output.$schema)).toBe(
      fileURLToPath(new URL("../jingler.plugin.schema.json", import.meta.url))
    )
  })
})
