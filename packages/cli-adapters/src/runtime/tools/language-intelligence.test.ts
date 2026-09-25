import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { languageHover, shutdownLanguageIntelligence } from "./language-intelligence.js"

const roots: string[] = []
afterEach(async () => {
  await shutdownLanguageIntelligence()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("language intelligence", () => {
  it("reuses TypeScript semantic hover", async () => {
    const root = await mkdtemp(join(tmpdir(), "jingler-language-hover-"))
    roots.push(root)
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({ include: ["*.ts"] }))
    await writeFile(join(root, "value.ts"), "export const answer = 42\n")

    await expect(languageHover(root, "value.ts", "answer", 1, 14)).resolves.toMatchObject({
      engine: "typescript-7-native",
      value: { type: "42" }
    })
  })

  it("rejects paths outside the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "jingler-language-hover-"))
    roots.push(root)
    await expect(languageHover(root, "../outside.ts", "value", 1, 1))
      .rejects.toThrow("escapes the workspace")
  })

  it("rejects Java symlinks that escape the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "jingler-language-hover-"))
    const outside = await mkdtemp(join(tmpdir(), "jingler-language-outside-"))
    roots.push(root, outside)
    await writeFile(join(outside, "Value.java"), "class Value {}\n")
    await symlink(join(outside, "Value.java"), join(root, "Value.java"))

    await expect(languageHover(root, "Value.java", "Value", 1, 7))
      .rejects.toThrow("escapes the workspace")
  })

  it("reports an unavailable JDT.LS without crashing", async () => {
    const root = await mkdtemp(join(tmpdir(), "jingler-language-hover-"))
    roots.push(root)
    await writeFile(join(root, "Value.java"), "class Value {}\n")
    const previousPath = process.env.PATH
    process.env.PATH = ""
    try {
      await expect(languageHover(root, "Value.java", "Value", 1, 7))
        .rejects.toThrow("JDT.LS could not start")
    } finally {
      process.env.PATH = previousPath
    }
  })
})
