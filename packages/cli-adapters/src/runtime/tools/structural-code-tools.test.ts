import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { registerStructuralCodeTools } from "./structural-code-tools.js"
import { ToolRegistry } from "./tool-registry.js"
import { applyIdentifierEdits, structuralMatches, structuralPreview } from "./typescript-analysis.js"

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

const project = async () => {
  const root = await mkdtemp(join(tmpdir(), "jingler-structural-"))
  roots.push(root)
  await writeFile(join(root, "tsconfig.json"), JSON.stringify({ include: ["*.ts"] }))
  await writeFile(join(root, "sample.ts"), [
    "const run = () => 1",
    "run()",
    "const text = 'run()'",
    "// run()",
    "const runner = run"
  ].join("\n"))
  return root
}

describe("structural code tools", () => {
  it("finds syntax without writing and hides apply from read-only roles", async () => {
    const root = await project()
    const before = await readFile(join(root, "sample.ts"), "utf8")
    expect(structuralMatches(root, "run", "call").value).toHaveLength(1)
    expect(structuralMatches(root, "run", "identifier").value).toHaveLength(3)
    expect(await readFile(join(root, "sample.ts"), "utf8")).toBe(before)
    const registry = new ToolRegistry()
    registerStructuralCodeTools(registry, root)
    expect(registry.capabilitiesFor("review", "read-only").map(({ id }) => id)).toContain("structural_search")
    expect(registry.capabilitiesFor("review", "read-only").map(({ id }) => id)).not.toContain("structural_edit")
  })

  it("fails closed when the preview count is stale", async () => {
    const root = await project()
    const registry = new ToolRegistry({
      observer: {
        started: () => Effect.succeed({ cwd: root, tree: "before" }),
        settled: () => Effect.succeed({
          id: "changes", callId: "structural", changes: [], totals: { added: 0, removed: 0 },
          authoritative: true, reconciledAt: "2026-01-01T00:00:00.000Z"
        })
      }
    })
    registerStructuralCodeTools(registry, root)
    const result = await Effect.runPromise(registry.execute({
      id: "structural_edit",
      arguments: { symbol: "run", kind: "identifier", newName: "execute", previewToken: "0".repeat(64) },
      role: "conversation",
      mode: "ask",
      idempotencyKey: "structural"
    }))
    expect(result).toMatchObject({ status: "error", error: { code: "execution-failed" } })
    expect(await readFile(join(root, "sample.ts"), "utf8")).toContain("run()")
  })

  it("binds apply to workspace source bytes, not only match count", async () => {
    const root = await project()
    const preview = structuralPreview(root, "run", "identifier")
    await writeFile(join(root, "sample.ts"), `${await readFile(join(root, "sample.ts"), "utf8")}\nconst added = run\n`)
    await expect(applyIdentifierEdits(
      root,
      preview.value.matches,
      "run",
      "execute",
      { kind: "identifier", token: preview.value.previewToken }
    )).rejects.toThrow("preview changed")
  })

  it("applies exactly the previewed identifier matches", async () => {
    const root = await project()
    const preview = structuralMatches(root, "run", "identifier")
    await applyIdentifierEdits(root, preview.value, "run", "execute")
    const result = await readFile(join(root, "sample.ts"), "utf8")
    expect(result).toContain("const execute")
    expect(result).toContain("execute()")
    expect(result).toContain("'run()'")
    expect(result).toContain("// run()")
    expect(result).toContain("runner")
  })
})
