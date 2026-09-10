import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveSubagentLaunchContract } from "pi-subagents/preflight"
import { afterEach, describe, expect, it } from "vitest"
import { JINGLER_SUBAGENT_NAMES, ProviderModelId } from "@jingler/core"
import { PONYTAIL_EXTENSION_PATH } from "../resources/ponytail-resources.js"
import { materializePiSubagentProfiles } from "./pi-subagents-bootstrap.js"

const roots: string[] = []
const originalAgentDir = process.env.PI_CODING_AGENT_DIR
afterEach(async () => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ))
})

const ceiling = {
  version: 1 as const,
  allowedTools: ["workspace_read_file", "contact_supervisor", "subagent"],
  allowedAgents: [...JINGLER_SUBAGENT_NAMES],
  denyExtensions: false,
  sources: ["jingler-runtime"]
}

const resolveAgent = (cwd: string, agent: string) =>
  resolveSubagentLaunchContract({
    agent,
    cwd,
    agentScope: "both",
    parentModel: { provider: "anthropic", id: "claude-test" },
    availableModels: [{
      provider: "anthropic",
      id: "claude-test",
      fullId: "anthropic/claude-test"
    }, {
      provider: "openai-codex",
      id: "gpt-5.6-sol",
      fullId: "openai-codex/gpt-5.6-sol"
    }],
    artifactDir: "session",
    parentSessionFile: join(cwd, "sessions", "parent.jsonl"),
    sessionRoot: join(cwd, "sessions"),
    capabilityCeiling: ceiling
  })

describe("managed pi-subagent profiles", () => {
  it("disables ambient extensions and reserves recursive spawn for fanout", async () => {
    const root = await mkdtemp(join(tmpdir(), "jingler-subagent-profiles-"))
    roots.push(root)
    const childTools = join(root, "jingler-child-tools.mjs")
    await writeFile(childTools, "export default () => undefined\n")
    await materializePiSubagentProfiles(root, childTools, {
      worker: ProviderModelId.make("openai-codex/gpt-5.6-sol")
    })
    process.env.PI_CODING_AGENT_DIR = root

    const scout = await resolveAgent(root, "scout")
    const worker = await resolveAgent(root, "worker")
    const fanout = await resolveAgent(root, "fanout")
    expect(scout.ok).toBe(true)
    expect(worker.ok).toBe(true)
    expect(fanout.ok).toBe(true)
    if (!(scout.ok && worker.ok && fanout.ok)) return
    expect(scout.contract.model).toBe("anthropic/claude-test:low")
    expect(worker.contract.model).toBe("openai-codex/gpt-5.6-sol:high")
    expect(scout.contract.inheritProjectContext).toBe(false)
    expect(scout.contract.roots.outputPath).toContain(
      join("subagent-artifacts", "outputs", "preflight", "context.md")
    )
    expect(scout.contract.inheritSkills).toBe(false)
    expect(scout.contract.tools.fanoutAuthorized).toBe(false)
    expect(scout.contract.tools.disableAmbientExtensions).toBe(true)
    expect(scout.contract.tools.configuredExtensions).toEqual([
      childTools,
      PONYTAIL_EXTENSION_PATH
    ])
    expect(scout.contract.tools.requestedBuiltin).toEqual(["contact_supervisor"])
    expect(fanout.contract.tools.fanoutAuthorized).toBe(true)
    expect(fanout.contract.tools.requestedBuiltin).toEqual([
      "subagent",
      "contact_supervisor"
    ])
  })

  it("does not admit a project-defined agent outside the agent ceiling", async () => {
    const root = await mkdtemp(join(tmpdir(), "jingler-subagent-ceiling-"))
    roots.push(root)
    const childTools = join(root, "jingler-child-tools.mjs")
    await writeFile(childTools, "export default () => undefined\n")
    await materializePiSubagentProfiles(root, childTools)
    await mkdir(join(root, ".pi", "agents"), { recursive: true })
    await writeFile(join(root, ".pi", "agents", "ambient.md"), [
      "---",
      "name: ambient",
      "description: Ambient project agent",
      "tools: bash",
      "---",
      "Ambient"
    ].join("\n"))
    process.env.PI_CODING_AGENT_DIR = root

    const result = await resolveAgent(root, "ambient")

    expect(result).toMatchObject({ ok: false, code: "restricted_agent" })
    expect(await readFile(join(root, "agents", "worker.md"), "utf8"))
      .toContain(`extensions: ${childTools}, `)
    expect(await readFile(join(root, "agents", "worker.md"), "utf8"))
      .toContain(PONYTAIL_EXTENSION_PATH)
  })
})
