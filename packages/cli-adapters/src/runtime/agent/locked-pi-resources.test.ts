import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import {
  assertLockedPiResources,
  createLockedPiResources
} from "./locked-pi-resources.js"
import { preparePiSubagentsRuntime } from "../subagents/pi-subagents-bootstrap.js"

const roots: string[] = []
const originalEnvironment = {
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  PI_SUBAGENT_PI_BINARY: process.env.PI_SUBAGENT_PI_BINARY,
  JINGLER_SUBAGENT_PI_CLI: process.env.JINGLER_SUBAGENT_PI_CLI,
  JINGLER_SUBAGENT_CREDENTIAL_ROOT: process.env.JINGLER_SUBAGENT_CREDENTIAL_ROOT,
  JINGLER_SUBAGENT_NODE: process.env.JINGLER_SUBAGENT_NODE
}
afterEach(async () => {
  for (const [name, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

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

    await Effect.runPromise(preparePiSubagentsRuntime(agentDir))
    const loader = await Effect.runPromise(createLockedPiResources({
      cwd,
      agentDir,
      systemPrompt: "Jingler owns this prompt"
    }))

    await Effect.runPromise(assertLockedPiResources(loader, "Jingler owns this prompt"))
    expect(loader.getSystemPrompt()).toBe("Jingler owns this prompt")
    expect(loader.getExtensions().extensions).toHaveLength(3)
    expect(loader.getExtensions().extensions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: expect.stringContaining("plannotator") })
      ])
    )
    const plannotator = loader.getExtensions().extensions.find(({ path }) =>
      path.includes("@plannotator/pi-extension")
    )
    expect([...plannotator!.tools.keys()]).toContain("plannotator_submit_plan")
    expect([...plannotator!.commands.keys()]).toContain("plannotator-plan-mode")
    expect(loader.getSkills().skills.map(({ name }) => name).sort()).toEqual([
      "ponytail",
      "ponytail-audit",
      "ponytail-debt",
      "ponytail-gain",
      "ponytail-help",
      "ponytail-review"
    ])
  })
})
