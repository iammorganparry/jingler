import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  disposeLanguageIntelligence,
  languageHover,
  shutdownLanguageIntelligence,
  syncJavaDocument
} from "./language-intelligence.js"
import { codeHover, disposeTypeScriptAnalysis } from "./typescript-analysis.js"

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

  it("refreshes a cached TypeScript project after source changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "jingler-language-hover-"))
    roots.push(root)
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({ include: ["*.ts"] }))
    await writeFile(join(root, "value.ts"), "export const answer = 42\n")

    await expect(languageHover(root, "value.ts", "answer", 1, 14)).resolves.toMatchObject({
      value: { type: "42" }
    })
    await writeFile(join(root, "value.ts"), "export const answer = 'updated'\n")
    await expect(languageHover(root, "value.ts", "answer", 1, 14)).resolves.toMatchObject({
      value: { type: "\"updated\"" }
    })
  })

  it("switches a cached hover to a newly selected nearer tsconfig", async () => {
    const root = await mkdtemp(join(tmpdir(), "jingler-language-hover-"))
    const sourceDir = join(root, "src")
    roots.push(root)
    await mkdir(sourceDir)
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({
      compilerOptions: { strictNullChecks: false },
      include: ["src/*.ts"]
    }))
    await writeFile(join(sourceDir, "value.ts"), "export const value = document.querySelector('x')\n")

    await expect(languageHover(root, "src/value.ts", "value", 1, 14)).resolves.toMatchObject({
      value: { type: "Element" }
    })
    await writeFile(join(sourceDir, "tsconfig.json"), JSON.stringify({
      compilerOptions: { strictNullChecks: true },
      include: ["*.ts"]
    }))
    await expect(languageHover(root, "src/value.ts", "value", 1, 14)).resolves.toMatchObject({
      value: { type: "Element | null" }
    })
  })

  it("does not recreate a TypeScript cache after disposal starts", async () => {
    const root = await mkdtemp(join(tmpdir(), "jingler-language-hover-"))
    roots.push(root)
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({ include: ["*.ts"] }))
    await writeFile(join(root, "value.ts"), "export const answer = 42\n")

    const hover = expect(codeHover(root, "value.ts", "answer", 1, 14))
      .rejects.toThrow("disposed while hover setup was in progress")
    await disposeTypeScriptAnalysis(root)
    await hover
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

  it("rejects a Java symbol that does not match the requested column", async () => {
    const root = await mkdtemp(join(tmpdir(), "jingler-language-hover-"))
    roots.push(root)
    await writeFile(join(root, "Value.java"), "class Value { int answer; }\n")

    await expect(languageHover(root, "Value.java", "missing", 1, 19))
      .rejects.toThrow("Symbol not found at requested Java position")
    await expect(languageHover(root, "Value.java", "a", 1, 19))
      .rejects.toThrow("Symbol not found at requested Java position")
    await expect(languageHover(root, "Value.java", "answer;", 1, 19))
      .rejects.toThrow("Invalid Java identifier")
    await writeFile(join(root, "Currency.java"), "class foo€bar {}\n")
    await expect(languageHover(root, "Currency.java", "foo", 1, 7))
      .rejects.toThrow("Symbol not found at requested Java position")
  })

  it("closes the least recently used Java document", () => {
    const sendNotification = vi.fn()
    const session = {
      connection: { sendNotification },
      versions: new Map()
    } as unknown as Parameters<typeof syncJavaDocument>[0]

    syncJavaDocument(session, "file:///0.java", "class C0 {}")
    for (let index = 1; index < 32; index += 1) {
      syncJavaDocument(session, `file:///${index}.java`, `class C${index} {}`)
    }
    syncJavaDocument(session, "file:///0.java", "class C0 {}")
    syncJavaDocument(session, "file:///32.java", "class C32 {}")

    expect(session.versions).toHaveLength(32)
    expect(sendNotification).toHaveBeenCalledWith("textDocument/didClose", {
      textDocument: { uri: "file:///1.java" }
    })
    syncJavaDocument(session, "file:///1.java", "class C1 {}")
    expect(sendNotification).toHaveBeenLastCalledWith("textDocument/didOpen", {
      textDocument: { uri: "file:///1.java", languageId: "java", version: 1, text: "class C1 {}" }
    })
  })

  it("does not create JDT.LS after disposal starts", async () => {
    const root = await mkdtemp(join(tmpdir(), "jingler-language-hover-"))
    roots.push(root)
    await writeFile(join(root, "Value.java"), "class Value {}\n")

    const hover = expect(languageHover(root, "Value.java", "Value", 1, 7))
      .rejects.toThrow("disposed while hover setup was in progress")
    await disposeLanguageIntelligence(root)
    await hover
  })

  it("accepts Java currency-symbol identifiers", async () => {
    const root = await mkdtemp(join(tmpdir(), "jingler-language-hover-"))
    roots.push(root)
    await writeFile(join(root, "Currency.java"), "class €value {}\n")
    const previousPath = process.env.PATH
    process.env.PATH = ""
    try {
      await expect(languageHover(root, "Currency.java", "€value", 1, 7))
        .rejects.toThrow("JDT.LS could not start")
    } finally {
      process.env.PATH = previousPath
    }
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
