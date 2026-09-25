import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { CURRENT_RUNTIME_CONTRACTS, type AgentRunSpec, type AgentEndpointCatalogEntry, type RuntimeContinuation } from "@jingler/core"
import { Effect, Stream } from "effect"
import { inactiveRuntimeActivity, type AgentRuntimeShape } from "../../src/runtime/agent/agent-runtime.js"
import { makeClaudeAgentRuntime } from "../../src/runtime/agent/claude-agent-runtime.js"
import { probeClaudeEndpoint } from "../../src/runtime/providers/claude-endpoint.js"
import { makeCodexAgentRuntime } from "../../src/runtime/codex/runtime.js"
import { probeCodexEndpoint } from "../../src/runtime/codex/endpoint.js"
import { makeOpenCodeAgentRuntime } from "../../src/runtime/opencode/runtime.js"
import { probeOpenCodeEndpoint } from "../../src/runtime/opencode/endpoint.js"

const adapters: Record<string, { probe: () => Promise<AgentEndpointCatalogEntry>; runtime: () => AgentRuntimeShape }> = {
  claude: { probe: probeClaudeEndpoint, runtime: makeClaudeAgentRuntime },
  codex: { probe: probeCodexEndpoint, runtime: makeCodexAgentRuntime },
  opencode: { probe: probeOpenCodeEndpoint, runtime: makeOpenCodeAgentRuntime }
}

async function main() {
  if (process.env.JINGLER_NATIVE_CERTIFY !== "1") throw new Error("Live certification requires explicit opt-in")
  const [runtimeId, version] = process.argv.slice(2)
  if (!runtimeId || !adapters[runtimeId] || !["minimum", "current"].includes(version ?? "")) throw new Error("Expected runtime and minimum|current")
  if (["JINGLER_CLAUDE_BINARY", "JINGLER_CODEX_BINARY", "JINGLER_OPENCODE_BINARY"].some(key => process.env[key])) throw new Error("Fixture binary overrides are forbidden")
  const expectedVersion = process.env.JINGLER_NATIVE_EXPECTED_VERSION
  if (!expectedVersion || !/^\d+\.\d+\.\d+$/.test(expectedVersion)) throw new Error("Expected resolved CLI version is required")
  const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim()
  if (git("status", "--porcelain", "--untracked-files=normal")) throw new Error("Certification requires a clean checkout")
  const commit = git("rev-parse", "HEAD")
  const adapter = adapters[runtimeId]!
  const entry = await adapter.probe()
  if (entry.endpoint.status !== "ready" || entry.endpoint.version?.match(/\d+\.\d+\.\d+/)?.[0] !== expectedVersion) throw new Error("CLI version or authentication gate failed")
  const model = entry.models.find(model => model.selectable)
  if (!model) throw new Error("No selectable model")
  const cwd = await mkdtemp(join(tmpdir(), "jingler-native-certification-"))
  try {
    execFileSync("git", ["init", "--quiet", cwd])
    const runtime = adapter.runtime()
    const context = { ...inactiveRuntimeActivity, canUseTool: () => Effect.succeed("deny" as const), askQuestion: () => Effect.succeed([]) }
    const run = async (continuation: RuntimeContinuation | null) => {
      const spec: AgentRunSpec = {
        runId: continuation ? "resume" : "prompt", sessionId: "certification", chatId: "certification",
        runtimeId: entry.endpoint.runtimeId, endpointId: entry.endpoint.id, providerId: model.providerId, modelId: model.id,
        role: "conversation", mode: "read-only", cwd, prompt: "Reply with exactly NATIVE_CERTIFIED. Do not use tools.",
        priorMessages: [], continuation, seed: null,
        targetCapabilities: { versions: CURRENT_RUNTIME_CONTRACTS, toolIds: [], resourceIds: [], targetId: "desktop" }
      }
      const events = [...await Effect.runPromise(runtime.run(spec, context).pipe(Stream.runCollect, Effect.timeout("120 seconds")))]
      const started = events.find(event => event._tag === "Started")
      if (!started || events.filter(event => event._tag === "Done").length !== 1 || events.some(event => event._tag === "Failed")) throw new Error("Turn failed")
      const text = events.flatMap(event => event._tag === "Assistant" ? [event.text] : []).join("")
      if (!text.includes("NATIVE_CERTIFIED")) throw new Error("Response gate failed")
      if (continuation && started.sessionId !== continuation.id) throw new Error("Native resume gate failed")
      return { runtimeId: entry.endpoint.runtimeId, endpointId: entry.endpoint.id, id: started.sessionId }
    }
    await run(await run(null))
    const output = resolve(process.env.JINGLER_NATIVE_ARTIFACT ?? `.artifacts/native-certification/${runtimeId}-${version}.json`)
    await mkdir(dirname(output), { recursive: true })
    await writeFile(output, `${JSON.stringify({ schemaVersion: 1, commit, runtime: runtimeId, version, cliVersion: expectedVersion, status: "passed", checks: ["discovery", "prompt", "resume"], timestamp: new Date().toISOString() })}\n`)
    console.log(`Native ${runtimeId}/${version} certification passed`)
  } finally { await rm(cwd, { recursive: true, force: true }) }
}

main().catch(() => {
  // Vendor exceptions may include credentials or transcript text. Keep logs bounded and generic.
  console.error("Native certification failed; inspect the CLI locally. No success artifact was produced.")
  process.exitCode = 1
})
