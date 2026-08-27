import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { registerCodeIntelligenceTools } from "./code-intelligence-tools.js"
import { ToolRegistry } from "./tool-registry.js"
import { applyIdentifierEdits, codeDefinitions, semanticReferences } from "./typescript-analysis.js"

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
    const references = semanticReferences(root, "packages/app/index.ts", "nested", 1)
    expect(references.value).toHaveLength(2)
  })

  it("follows aliases and excludes a shadowed identifier", async () => {
    const root = await project()
    const references = semanticReferences(root, "source.ts", "token", 1)
    expect(references.engine).toBe("typescript-7-native")
    expect(references.timing.requestCount).toBeGreaterThan(0)
    expect(references.value.map(({ path, text }) => `${path}:${text}`)).toEqual([
      "source.ts:token",
      "reexport.ts:token"
    ])
  })

  it("resolves an imported alias definition to its exported declaration", async () => {
    const root = await project()
    const definitions = codeDefinitions(root, "use.ts", "publicToken", 1)
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

  it("rejects edits through a symlink", async () => {
    const root = await project()
    const outside = await mkdtemp(join(tmpdir(), "jingler-code-outside-"))
    roots.push(outside)
    await writeFile(join(outside, "outside.ts"), "export const token = 1\n")
    await symlink(join(outside, "outside.ts"), join(root, "linked.ts"))
    expect(() => semanticReferences(root, "linked.ts", "token", 1)).toThrow("outside the workspace")
    await expect(applyIdentifierEdits(root, [{ path: "linked.ts", line: 1, column: 14, text: "token" }], "token", "credential"))
      .rejects.toThrow("crosses a symlink")
    expect(await readFile(join(outside, "outside.ts"), "utf8")).toContain("token")
  })

  it("rejects an invalid rename before writing", async () => {
    const root = await project()
    const before = await readFile(join(root, "source.ts"), "utf8")
    const references = semanticReferences(root, "source.ts", "token", 1)
    await expect(applyIdentifierEdits(root, references.value, "token", "not-valid-name"))
      .rejects.toMatchObject({ code: "invalid-input" })
    expect(await readFile(join(root, "source.ts"), "utf8")).toBe(before)
  })

  it("applies all resolved references and leaves strings and shadowed names unchanged", async () => {
    const root = await project()
    const references = semanticReferences(root, "source.ts", "token", 1)
    await applyIdentifierEdits(root, references.value, "token", "credential")
    expect(await readFile(join(root, "source.ts"), "utf8")).toContain("const credential = 1")
    expect(await readFile(join(root, "source.ts"), "utf8")).toContain("'token'")
    expect(await readFile(join(root, "reexport.ts"), "utf8")).toContain("{ credential as publicToken }")
    expect(await readFile(join(root, "use.ts"), "utf8")).toContain("const token = 2")
  })
})
