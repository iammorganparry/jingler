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
    const claudeProvider = join(root, "jingler-claude-cli-provider.mjs")
    await Promise.all([
      writeFile(childTools, "export default () => undefined\n"),
      writeFile(claudeProvider, "export default () => undefined\n")
    ])
    await materializePiSubagentProfiles(
      root,
      childTools,
      claudeProvider,
      { worker: ProviderModelId.make("openai-codex/gpt-5.6-sol") },
      { worker: ["workspace_read_file"] }
    )
    process.env.PI_CODING_AGENT_DIR = root

    const scout = await resolveAgent(root, "scout")
    const worker = await resolveAgent(root, "worker")
    const fanout = await resolveAgent(root, "fanout")
    expect(scout.ok).toBe(true)
    expect(worker.ok).toBe(true)
    expect(fanout.ok).toBe(true)
    if (!(scout.ok && worker.ok && fanout.ok)) return
    expect(scout.contract.model).toBe("anthropic/claude-test:low")
    expect(worker.contract.model).toBe("openai-codex/gpt-5.6-sol:medium")
    expect(worker.contract.tools.requestedBuiltin).toEqual([
      "contact_supervisor",
      "workspace_read_file"
    ])
    expect(scout.contract.inheritProjectContext).toBe(false)
    expect(await readFile(join(root, "agents", "worker.md"), "utf8"))
      .toMatch(/^defaultContext: fresh$/m)
    expect(scout.contract.roots.outputPath).toContain(
      join("subagent-artifacts", "outputs", "preflight", "context.md")
    )
    expect(scout.contract.inheritSkills).toBe(false)
    expect(scout.contract.tools.fanoutAuthorized).toBe(false)
    expect(scout.contract.tools.disableAmbientExtensions).toBe(true)
    // `extensions` and `subagentOnlyExtensions` both list the child extensions.
    const childExtensions = [childTools, claudeProvider, PONYTAIL_EXTENSION_PATH]
    expect(scout.contract.tools.configuredExtensions).toEqual([
      ...childExtensions,
      ...childExtensions
    ])
    expect(scout.contract.tools.requestedBuiltin).toEqual(["contact_supervisor"])
    // Foreground children load only the child-only list, so every profile must carry it.
    for (const agent of [...JINGLER_SUBAGENT_NAMES]) {
      const profile = await readFile(join(root, "agents", `${agent}.md`), "utf8")
      expect(profile).toContain(
        `subagentOnlyExtensions: ${childTools}, ${claudeProvider}, ${PONYTAIL_EXTENSION_PATH}`
      )
    }
    for (const agent of ["worker", "oracle"]) {
      const profile = await readFile(join(root, "agents", `${agent}.md`), "utf8")
      expect(profile).toMatch(/^defaultContext: fresh$/m)
    }
    expect(fanout.contract.tools.fanoutAuthorized).toBe(true)
    expect(fanout.contract.tools.requestedBuiltin).toEqual([
      "subagent",
      "contact_supervisor"
    ])
  })

  // Integration level: the e2e fixtures replace the child process, so they cannot see which
  // extensions a foreground `delegate` actually launches with. This reads the launch plan.
  it("launches a foreground delegate with the child-tools extension and command_execute", async () => {
    const root = await mkdtemp(join(tmpdir(), "jingler-subagent-profiles-"))
    roots.push(root)
    const childTools = join(root, "jingler-child-tools.mjs")
    await writeFile(childTools, "export default () => undefined\n")
    await materializePiSubagentProfiles(root, childTools, "claude.mjs", {}, {
      delegate: ["command_execute", "workspace_read_file"]
    })
    process.env.PI_CODING_AGENT_DIR = root
    const delegate = await resolveAgent(root, "delegate")
    expect(delegate.ok).toBe(true)
    if (!delegate.ok) return
    expect(delegate.contract.tools.extensionArgs).toContain(childTools)
    expect(delegate.contract.tools.requestedBuiltin).toContain("command_execute")
    expect(await readFile(join(root, "agents", "delegate.md"), "utf8"))
      .toContain(`subagentOnlyExtensions: ${childTools},`)
  })

  it("drops command_inspect only where command_execute is offered", async () => {
    const root = await mkdtemp(join(tmpdir(), "jingler-subagent-profiles-"))
    roots.push(root)
    await materializePiSubagentProfiles(root, "child.mjs", "claude.mjs", {}, {
      worker: ["command_inspect", "command_execute", "workspace_edit"],
      fanout: ["command_inspect", "command_execute"],
      reviewer: ["command_inspect", "workspace_read_file"]
    })
    const toolsOf = async (agent: string) =>
      (await readFile(join(root, "agents", `${agent}.md`), "utf8"))
        .match(/^tools: (.*)$/m)?.[1]
    expect(await toolsOf("worker")).toBe(
      "contact_supervisor, command_execute, workspace_edit"
    )
    expect(await toolsOf("fanout")).toBe(
      "subagent, contact_supervisor, command_execute"
    )
    expect(await toolsOf("reviewer")).toBe(
      "contact_supervisor, command_inspect, workspace_read_file"
    )
  })

  it("keeps the profile tool lists when a toolless host rewrites the profiles", async () => {
    const root = await mkdtemp(join(tmpdir(), "jingler-subagent-profiles-"))
    roots.push(root)
    await materializePiSubagentProfiles(root, "child.mjs", "claude.mjs", {}, {
      worker: ["command_execute", "workspace_write", "workspace_edit"]
    })
    // The native-sidecar recovery host has an empty registry and passes no tools.
    await materializePiSubagentProfiles(root, "child.mjs", "claude.mjs", {})
    const tools = (await readFile(join(root, "agents", "worker.md"), "utf8"))
      .match(/^tools: (.*)$/m)?.[1]
    expect(tools).toBe("contact_supervisor, command_execute, workspace_write, workspace_edit")
  })

  it("does not admit a project-defined agent outside the agent ceiling", async () => {
    const root = await mkdtemp(join(tmpdir(), "jingler-subagent-ceiling-"))
    roots.push(root)
    const childTools = join(root, "jingler-child-tools.mjs")
    const claudeProvider = join(root, "jingler-claude-cli-provider.mjs")
    await Promise.all([
      writeFile(childTools, "export default () => undefined\n"),
      writeFile(claudeProvider, "export default () => undefined\n")
    ])
    await materializePiSubagentProfiles(root, childTools, claudeProvider)
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

  it("runs workers at medium thinking instead of the vendor's high", async () => {
    const root = await mkdtemp(join(tmpdir(), "jingler-thinking-"))
    roots.push(root)
    await materializePiSubagentProfiles(root, "child.mjs", "claude.mjs")
    const worker = await readFile(join(root, "agents", "worker.md"), "utf8")
    expect(worker).toMatch(/^thinking: medium$/m)
    expect(worker).not.toMatch(/^thinking: high$/m)
  })
})
