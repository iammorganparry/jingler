import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { detectAgentResources } from "./resource-detector.js"

const roots: string[] = []
const temporary = async () => {
  const root = await mkdtemp(join(tmpdir(), "jingler-resources-"))
  roots.push(root)
  return root
}
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

describe("resource detection", () => {
  it("detects skill and prompt metadata without copying source files", async () => {
    const home = await temporary()
    const skill = join(home, ".claude", "skills", "deploy")
    const prompts = join(home, ".claude", "commands")
    await mkdir(skill, { recursive: true })
    await mkdir(prompts, { recursive: true })
    await writeFile(join(skill, "SKILL.md"), "name: deploy\ndescription: Ship safely\n")
    await writeFile(join(prompts, "review.md"), "Review this change")

    const result = await Effect.runPromise(detectAgentResources({ homeDir: home, worktreePath: null }))

    expect(result.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "skill", id: "deploy", description: "Ship safely" }),
      expect.objectContaining({ kind: "prompt", id: "review" })
    ]))
    expect(await readFile(join(skill, "SKILL.md"), "utf8")).toContain("Ship safely")
  })

  it("reports an escaping skill symlink without reading its target", async () => {
    const home = await temporary()
    const outside = await temporary()
    const skills = join(home, ".agents", "skills")
    await mkdir(skills, { recursive: true })
    await writeFile(join(outside, "SKILL.md"), "name: stolen\ndescription: private\n")
    await symlink(outside, join(skills, "escape"))

    const result = await Effect.runPromise(detectAgentResources({ homeDir: home, worktreePath: null }))

    expect(result.candidates).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "stolen" })
    ]))
    expect(result.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "escaping-path" })
    ]))
  })

  it("detects MCP configuration as redacted review metadata", async () => {
    const home = await temporary()
    await mkdir(join(home, ".pi", "agent"), { recursive: true })
    await writeFile(join(home, ".pi", "agent", "mcp.json"), JSON.stringify({
      headers: { Authorization: "secret" }
    }))

    const result = await Effect.runPromise(detectAgentResources({ homeDir: home, worktreePath: null }))
    const serialized = JSON.stringify(result)

    expect(result.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "mcp", name: "pi MCP configuration" })
    ]))
    expect(serialized).not.toContain("secret")
    expect(serialized).not.toContain("Authorization")
  })
})
