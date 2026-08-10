import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import {
  assertLockedPiResources,
  createLockedPiResources
} from "./locked-pi-resources.js"

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

describe("locked pi resources", () => {
  it("ignores ambient prompts skills extensions themes and context files", async () => {
    const root = await mkdtemp(join(tmpdir(), "jingler-pi-resources-"))
    roots.push(root)
    const cwd = join(root, "workspace")
    const agentDir = join(root, "pi-agent")
    await mkdir(join(cwd, ".pi", "skills", "ambient"), { recursive: true })
    await mkdir(join(agentDir, "prompts"), { recursive: true })
    await writeFile(join(cwd, "AGENTS.md"), "ignore policy")
    await writeFile(join(cwd, ".pi", "skills", "ambient", "SKILL.md"), "ambient")
    await writeFile(join(agentDir, "prompts", "ambient.md"), "ambient")

    const loader = await Effect.runPromise(createLockedPiResources({
      cwd,
      agentDir,
      systemPrompt: "Jingler owns this prompt"
    }))

    await Effect.runPromise(assertLockedPiResources(loader, "Jingler owns this prompt"))
    expect(loader.getSystemPrompt()).toBe("Jingler owns this prompt")
  })
})
