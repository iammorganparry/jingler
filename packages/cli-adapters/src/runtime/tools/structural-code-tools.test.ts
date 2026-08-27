import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { applyIdentifierEdits, structuralMatches } from "./typescript-analysis.js"

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
  it("finds syntax but not comments, strings, or longer identifiers", async () => {
    const root = await project()
    expect(structuralMatches(root, "run", "call").value).toHaveLength(1)
    expect(structuralMatches(root, "run", "identifier").value).toHaveLength(3)
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
