import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CURRENT_RUNTIME_CONTRACTS, nativeCliEndpointId, ProviderModelId, type AgentRunSpec } from "@jingler/core"
import { Effect, Stream } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { makeClaudeAgentRuntime } from "../agent/claude-agent-runtime.js"
import { inactiveRuntimeActivity } from "../agent/agent-runtime.js"
import { makeAgentResourceService } from "./agent-resource-service.js"
import { makePortableRuntime } from "./portable-runtime.js"
import { detectAgentResources } from "./resource-detector.js"

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
const spec = (overrides: Partial<AgentRunSpec> = {}): AgentRunSpec => ({
  runId: "r", sessionId: "s", chatId: "a", runtimeId: "claude", endpointId: nativeCliEndpointId("desktop", "claude"),
  modelId: ProviderModelId.make("anthropic/haiku"), role: "conversation", mode: "auto", cwd: "/tmp", prompt: "hello",
  priorMessages: [], continuation: null, seed: null,
  targetCapabilities: { targetId: "desktop", versions: CURRENT_RUNTIME_CONTRACTS, toolIds: [], resourceIds: [] },
  ...overrides
})
const context = { ...inactiveRuntimeActivity, canUseTool: () => Effect.succeed("deny" as const), askQuestion: () => Effect.succeed([]) }
const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), "jingler-portable-")); roots.push(root)
  const service = await Effect.runPromise(makeAgentResourceService({ managedRoot: join(root, "resources") }))
  const received: AgentRunSpec[] = []
  const harness = { ...makeClaudeAgentRuntime(), run: (input: AgentRunSpec) => {
    received.push(input)
    return Stream.make({ _tag: "Done" as const, tokens: 0, costUsd: 0 })
  } }
  const wrap = () => makePortableRuntime(service, join(root, "modes.json"), root)(harness)
  const run = (runtime: ReturnType<typeof wrap>, input: AgentRunSpec) => Effect.runPromise(runtime.run(input, context).pipe(Stream.runCollect))
  return { root, service, received, wrap, run }
}

describe("Jingler portable skills", () => {
  it("persists independent chat modes across restart and harness changes without calling a model for commands", async () => {
    const { received, wrap, run } = await setup()
    const first = wrap()
    await run(first, spec({ prompt: "/ponytail ultra" }))
    await run(first, spec({ chatId: "b", prompt: "/ponytail off" }))
    expect(received).toHaveLength(0)
    const restarted = wrap()
    for (const runtimeId of ["pi", "claude", "codex", "opencode"] as const) {
      await run(restarted, spec({ runtimeId }))
      expect(received.at(-1)?.ponytailMode).toBe("ultra")
      await run(restarted, spec({ runtimeId, chatId: "b" }))
      expect(received.at(-1)?.ponytailMode).toBe("off")
    }
    await run(restarted, spec({ prompt: "normal mode" }))
    await run(restarted, spec())
    expect(received.at(-1)?.ponytailMode).toBe("off")
  })

  it("migrates the persisted Pi mode without its original visible command, only once", async () => {
    const { root, received, wrap, run } = await setup()
    const file = join(root, "legacy.jsonl")
    const entries = [
      { type: "session", version: 3, id: "legacy", cwd: root, timestamp: new Date().toISOString() },
      { type: "custom", id: "mode", parentId: null, customType: "ponytail-mode", data: { mode: "ultra" }, timestamp: new Date().toISOString() }
    ]
    await writeFile(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n")
    const input = spec({ runtimeId: "pi", seed: { reason: "migration", messages: [] }, continuation: { runtimeId: "pi", endpointId: spec().endpointId, id: file } })
    await run(wrap(), input)
    expect(received.at(-1)?.ponytailMode).toBe("ultra")
    await run(wrap(), { ...input, prompt: "/ponytail off" })
    await run(wrap(), input)
    expect(received.at(-1)?.ponytailMode).toBe("off")
  })

  it("uses raw operator text, not injected policy, for mode commands", async () => {
    const { received, wrap, run } = await setup()
    const runtime = wrap()
    await run(runtime, spec({ operatorPrompt: "/ponytail lite", prompt: "/ponytail lite\n\nPOLICY" }))
    await run(runtime, spec({ operatorPrompt: "add a normal mode toggle", prompt: "normal mode" }))
    expect(received.at(-1)?.ponytailMode).toBe("lite")
    const status = [...await run(runtime, spec({ prompt: "/ponytail status" }))]
    expect(status).toContainEqual({ _tag: "Assistant", text: "Ponytail: lite." })
  })

  it("expands the same bundled skill for all runtimes without loading native plugins", async () => {
    const { received, wrap, run } = await setup()
    const runtime = wrap()
    for (const runtimeId of ["pi", "claude", "codex", "opencode"] as const) {
      await run(runtime, spec({ runtimeId, operatorPrompt: "/skill:ponytail-review current diff", prompt: "/skill:ponytail-review current diff\n\nKEEP POLICY" }))
      expect(received.at(-1)?.prompt).toContain("Review diffs for unnecessary complexity")
      expect(received.at(-1)?.prompt).toContain("current diff")
      expect(received.at(-1)?.prompt).toContain("KEEP POLICY")
      expect(received.at(-1)?.ponytailMode).toBe("review")
    }
  })

  it("serves Jingler-specific help across harnesses", async () => {
    const { received, wrap, run } = await setup()
    await run(wrap(), spec({ prompt: "/ponytail-help" }))
    expect(received.at(-1)?.prompt).toContain("/ponytail lite|full|ultra|off")
    expect(received.at(-1)?.prompt).toContain("Update Jingler")
    expect(received.at(-1)?.prompt).not.toMatch(/@ponytail|\/plugin|\/reload-plugins/u)
  })

  it("expands enabled managed skills but does not load target-disabled resources", async () => {
    const { root, service, received, wrap, run } = await setup()
    const source = join(root, ".agents", "skills", "deploy")
    await mkdir(source, { recursive: true })
    await writeFile(join(source, "SKILL.md"), "---\nname: deploy\ndescription: Deploy safely\n---\nDeploy $ARGUMENTS after tests.")
    const candidates = (await Effect.runPromise(detectAgentResources({ homeDir: root, worktreePath: null }))).candidates
    await Effect.runPromise(service.importResources(candidates, { kind: "portable", allowedTargets: ["desktop"] }))
    const runtime = wrap()
    await run(runtime, spec({ prompt: "POLICY\n/deploy staging", operatorPrompt: "/deploy staging" }))
    expect(received.at(-1)?.prompt).toContain("Deploy staging after tests.")
    expect(received.at(-1)?.prompt).toContain("POLICY")
    await expect(run(runtime, spec({ prompt: "/deploy staging", targetCapabilities: { ...spec().targetCapabilities, targetId: "other" } })))
      .rejects.toThrow("disabled or unavailable")
    await run(runtime, spec({ prompt: "/deploy $& $` $' $$" }))
    expect(received.at(-1)?.prompt).toContain("Deploy $& $` $' $$ after tests.")
    expect(received).toHaveLength(2)
  })
})
