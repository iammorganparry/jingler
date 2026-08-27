import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { registerCodeIntelligenceTools } from "./code-intelligence-tools.js"
import { ToolRegistry } from "./tool-registry.js"
import { applyIdentifierEdits, codeDefinitions, semanticReferences, semanticRename } from "./typescript-analysis.js"

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

const project = async () => {
  const root = await mkdtemp(join(tmpdir(), "jingler-code-intelligence-"))
  roots.push(root)
  await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true }, include: ["*.ts"] }))
  await writeFile(join(root, "source.ts"), "export const token = 1\nexport const untouched = 'token'\n")
  await writeFile(join(root, "reexport.ts"), "export { token as publicToken } from './source'\n")
  await writeFile(join(root, "use.ts"), "import { publicToken } from './reexport'\nconst token = 2\nexport const value = publicToken + token\n")
  return root
}

describe("code intelligence tools", () => {
  it("discovers a package tsconfig from a monorepo root", async () => {
    const root = await mkdtemp(join(tmpdir(), "jingler-code-monorepo-"))
    roots.push(root)
    const packageRoot = join(root, "packages", "app")
    await mkdir(packageRoot, { recursive: true })
    await writeFile(join(packageRoot, "tsconfig.json"), JSON.stringify({ include: ["*.ts"] }))
    await writeFile(join(packageRoot, "index.ts"), "export const nested = 1\nexport const value = nested\n")
    const references = await semanticReferences(root, "packages/app/index.ts", "nested", 1)
    expect(references.value).toHaveLength(2)
  })

  it("rejects TypeScript project inputs outside the workspace", async () => {
    const root = await project()
    const outside = join(tmpdir(), "outside.ts")
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({ files: ["source.ts", outside] }))
    await expect(semanticReferences(root, "source.ts", "token", 1, 14))
      .rejects.toThrow("escapes the workspace")
  })

  it("follows aliases and excludes a shadowed identifier", async () => {
    const root = await project()
    const references = await semanticReferences(root, "source.ts", "token", 1)
    expect(references.engine).toBe("typescript-7-native")
    expect(references.timing.requestCount).toBeGreaterThan(0)
    expect(references.value.map(({ path, text }) => `${path}:${text}`)).toEqual([
      "source.ts:token",
      "reexport.ts:token"
    ])
  })

  it("resolves an imported alias definition to its exported declaration", async () => {
    const root = await project()
    const definitions = await codeDefinitions(root, "use.ts", "publicToken", 1)
    expect(definitions.value.map(({ path }) => path)).toContain("source.ts")
  })

  it("keeps mutation unavailable to plan and review roles", async () => {
    const root = await project()
    const registry = new ToolRegistry()
    registerCodeIntelligenceTools(registry, root)
    expect(registry.capabilitiesFor("plan", "plan").map(({ id }) => id)).toContain("code_intelligence")
    expect(registry.capabilitiesFor("plan", "plan").map(({ id }) => id)).not.toContain("code_rename")
    const ambiguous = await Effect.runPromise(registry.execute({
      id: "code_intelligence",
      arguments: { action: "references", file: "source.ts", symbol: "token" },
      role: "plan",
      mode: "plan"
    }))
    expect(ambiguous).toMatchObject({ status: "error", error: { code: "invalid-input" } })
    const denied = await Effect.runPromise(registry.execute({
      id: "code_rename",
      arguments: { file: "source.ts", symbol: "token", line: 1, newName: "credential" },
      role: "review",
      mode: "read-only",
      idempotencyKey: "rename-1"
    }))
    expect(denied).toMatchObject({ status: "error", error: { code: "forbidden" } })
  })

  it("requires a column when the same symbol appears twice on one line", async () => {
    const root = await project()
    await writeFile(join(root, "ambiguous.ts"), "const token = 1; console.log(token)\n")
    await expect(semanticReferences(root, "ambiguous.ts", "token", 1)).rejects.toThrow("provide column")
    await expect(semanticReferences(root, "ambiguous.ts", "token", 1, 7)).resolves.toMatchObject({
      value: expect.arrayContaining([expect.objectContaining({ column: 7 })])
    })
  })

  it("rolls back a rename that changes symbol binding", async () => {
    const root = await project()
    await writeFile(join(root, "collision.ts"), "const token = 1\nconst credential = 2\nconsole.log(token)\n")
    const before = await readFile(join(root, "collision.ts"), "utf8")
    await expect(semanticRename(root, "collision.ts", "token", 1, 7, "credential"))
      .rejects.toThrow("change symbol binding")
    expect(await readFile(join(root, "collision.ts"), "utf8")).toBe(before)
  })

  it("rolls back a rename that introduces a collision in another file", async () => {
    const root = await project()
    await writeFile(join(root, "collision-export.ts"), "export { token } from './source'\nexport const credential = 2\n")
    const before = await readFile(join(root, "source.ts"), "utf8")
    await expect(semanticRename(root, "source.ts", "token", 1, 14, "credential"))
      .rejects.toThrow("change symbol binding")
    expect(await readFile(join(root, "source.ts"), "utf8")).toBe(before)
  })

  it("rejects imports that resolve through an internal symlink", async () => {
    const root = await project()
    const outside = await mkdtemp(join(tmpdir(), "jingler-import-outside-"))
    roots.push(outside)
    await writeFile(join(outside, "module.ts"), "export const value = 1\n")
    await symlink(outside, join(root, "linked-module"))
    await writeFile(join(root, "importer.ts"), "import './linked-module/module'\nexport const result = 1\n")
    await expect(semanticReferences(root, "importer.ts", "result", 2, 14))
      .rejects.toThrow("resolves outside the workspace")
  })

  it("rejects edits through a symlink", async () => {
    const root = await project()
    const outside = await mkdtemp(join(tmpdir(), "jingler-code-outside-"))
    roots.push(outside)
    await writeFile(join(outside, "outside.ts"), "export const token = 1\n")
    await symlink(join(outside, "outside.ts"), join(root, "linked.ts"))
    await expect(semanticReferences(root, "linked.ts", "token", 1)).rejects.toThrow("outside the workspace")
    await expect(applyIdentifierEdits(root, [{ path: "linked.ts", line: 1, column: 14, text: "token" }], "token", "credential"))
      .rejects.toThrow("crosses a symlink")
    expect(await readFile(join(outside, "outside.ts"), "utf8")).toContain("token")
  })

  it("refuses to overwrite a file held by another Jingler edit", async () => {
    const root = await project()
    const before = await readFile(join(root, "source.ts"), "utf8")
    await writeFile(join(root, "source.ts.jingler-edit.lock"), "other\n")
    await expect(applyIdentifierEdits(root, [{ path: "source.ts", line: 1, column: 14, text: "token" }], "token", "credential"))
      .rejects.toThrow("already changing")
    expect(await readFile(join(root, "source.ts"), "utf8")).toBe(before)
  })

  it("reclaims a lock left by a dead editor process", async () => {
    const root = await project()
    const staleLock = join(root, "source.ts.jingler-edit.lock")
    await mkdir(staleLock)
    await utimes(staleLock, new Date(0), new Date(0))
    await expect(applyIdentifierEdits(root, [{ path: "source.ts", line: 1, column: 14, text: "token" }], "token", "credential"))
      .resolves.toMatchObject({ replacements: 1 })
    expect(await readFile(join(root, "source.ts"), "utf8")).toContain("credential")
  })

  it("rejects an invalid rename before writing", async () => {
    const root = await project()
    const before = await readFile(join(root, "source.ts"), "utf8")
    const references = await semanticReferences(root, "source.ts", "token", 1)
    await expect(applyIdentifierEdits(root, references.value, "token", "not-valid-name"))
      .rejects.toMatchObject({ code: "invalid-input" })
    expect(await readFile(join(root, "source.ts"), "utf8")).toBe(before)
  })

  it("applies all resolved references and leaves strings and shadowed names unchanged", async () => {
    const root = await project()
    const references = await semanticReferences(root, "source.ts", "token", 1)
    await applyIdentifierEdits(root, references.value, "token", "credential")
    expect(await readFile(join(root, "source.ts"), "utf8")).toContain("const credential = 1")
    expect(await readFile(join(root, "source.ts"), "utf8")).toContain("'token'")
    expect(await readFile(join(root, "reexport.ts"), "utf8")).toContain("{ credential as publicToken }")
    expect(await readFile(join(root, "use.ts"), "utf8")).toContain("const token = 2")
  })
})
