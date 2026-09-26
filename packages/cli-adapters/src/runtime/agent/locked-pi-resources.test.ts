import config from "@jingler/plannotator-ext/plannotator.json" with { type: "json" }
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  assertLockedPiResources,
  createLockedPiResources
} from "./locked-pi-resources.js"
import { preparePiSubagentsRuntime } from "../subagents/pi-subagents-bootstrap.js"

const roots: string[] = []
const originalEnvironment = {
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  JINGLER_SUBAGENT_PROCESS_ISOLATION: process.env.JINGLER_SUBAGENT_PROCESS_ISOLATION,
  JINGLER_SUBAGENT_CREDENTIAL_ROOT: process.env.JINGLER_SUBAGENT_CREDENTIAL_ROOT,
  JINGLER_SUBAGENT_NODE: process.env.JINGLER_SUBAGENT_NODE
}
beforeEach(() => {
  for (const name of Object.keys(originalEnvironment)) delete process.env[name]
})
afterEach(async () => {
  for (const [name, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("locked pi resources", () => {
  it("ships the enhanced Markdown plan shape in the active phase prompt", () => {
    expect(config.phases.planning.activeTools).toEqual(expect.arrayContaining([
      "workspace_list_files",
      "workspace_read_file",
      "command_inspect",
      "code_intelligence",
      "structural_search",
      "write",
      "edit",
      "plannotator_submit_plan"
    ]))
    const prompt = config.phases.planning.instructions
    expect(prompt).toContain("stable-stage-id")
    expect(prompt).toContain("### Acceptance")
    expect(prompt).toContain("### Files")
    expect(prompt).toContain("complexity:")
    expect(prompt).toContain("depends:")
    expect(prompt).toContain("Optional substep")
  })

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

    await Effect.runPromise(preparePiSubagentsRuntime(agentDir))
    const loader = await Effect.runPromise(createLockedPiResources({
      cwd,
      agentDir,
      systemPrompt: "Jingler owns this prompt"
    }))

    await Effect.runPromise(assertLockedPiResources(loader, "Jingler owns this prompt"))
    expect(loader.getSystemPrompt()).toBe("Jingler owns this prompt")
    expect(loader.getExtensions().extensions).toHaveLength(1)
    expect(loader.getExtensions().extensions[0]?.path).toContain("pi-subagents")
    expect(loader.getSkills().skills).toEqual([])
  })
})
