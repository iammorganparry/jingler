import { spawn, type SpawnOptionsWithoutStdio } from "node:child_process"
import { chmod, mkdtemp, writeFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  CURRENT_RUNTIME_CONTRACTS,
  nativeCliEndpointId,
  ProviderModelId,
  type AgentRunSpec
} from "@jingler/core"
import { Effect, Schema, Stream } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  claudeAgentArguments,
  makeClaudeAgentRuntime
} from "./claude-agent-runtime.js"
import { probeClaudeEndpoint } from "../providers/claude-endpoint.js"
import * as toolRelay from "../providers/claude-cli-tool-relay.js"
import { nativeCliEnvironment } from "../providers/native-cli-environment.js"
import { ToolRegistry } from "../tools/tool-registry.js"
import { AgentRuntimeError, inactiveRuntimeActivity } from "./agent-runtime.js"

const endpointId = nativeCliEndpointId("desktop", "claude")
const spec = (over: Partial<AgentRunSpec> = {}): AgentRunSpec => ({
  runId: "run-1",
  sessionId: "session-1",
  chatId: "chat-1",
  runtimeId: "claude",
  endpointId,
  modelId: Schema.decodeUnknownSync(ProviderModelId)("anthropic/opus"),
  role: "conversation",
  mode: "auto",
  cwd: "/tmp",
  prompt: "hello",
  priorMessages: [],
  continuation: null,
  seed: null,
  targetCapabilities: {
    versions: CURRENT_RUNTIME_CONTRACTS,
    toolIds: [],
    resourceIds: [],
    targetId: "desktop"
  },
  ...over
})

const directories: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))) })

const executable = async (body: string): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "jingler-claude-runtime-"))
  directories.push(directory)
  const file = join(directory, "claude-fixture.mjs")
  await writeFile(file, `#!/usr/bin/env node\n${body}`)
  await chmod(file, 0o755)
  return file
}

const context = {
  ...inactiveRuntimeActivity,
  canUseTool: () => Effect.succeed("deny" as const),
  askQuestion: () => Effect.succeed([])
}

describe("ClaudeAgentRuntime", () => {
  it("uses native session creation and resume flags", () => {
    expect(claudeAgentArguments(spec(), "new-session")).toContain("--session-id")
    const resumed = claudeAgentArguments(spec({
      continuation: { runtimeId: "claude", endpointId, id: "prior-session" }
    }), "ignored")
    expect(resumed).toContain("--resume")
    expect(resumed).toContain("prior-session")
    expect(resumed).toContain("--safe-mode")
    expect(resumed).not.toContain("--setting-sources")
    const reasoned = claudeAgentArguments(spec({
      reasoning: { enabled: true, effort: "xhigh" }
    }), "new-session")
    expect(reasoned.slice(reasoned.indexOf("--effort"), reasoned.indexOf("--effort") + 2))
      .toEqual(["--effort", "max"])
  })

  it("passes only non-secret operating environment variables", () => {
    expect(nativeCliEnvironment({
      PATH: "/bin",
      HOME: "/home/test",
      JINGLER_PROVIDER_ACCESS: "secret",
      OPENAI_API_KEY: "secret",
      CUSTOM_TOKEN: "secret"
    })).toEqual({ PATH: "/bin", HOME: "/home/test" })
  })

  it("seeds transcript text and images into a fresh native session", async () => {
    const binary = await executable(`
let input=""; process.stdin.on("data",(chunk)=>input+=chunk); process.stdin.on("end",()=>{
 const line=JSON.parse(input.trim()); const content=line.message.content;
 const seeded=content[0].text.includes("Earlier context") && content.some((part)=>part.type==="image");
 console.log(JSON.stringify({type:"stream_event",event:{type:"content_block_delta",delta:{type:"text_delta",text:seeded?"seeded":"missing"}}}));
 console.log(JSON.stringify({type:"result",is_error:false,usage:{}}));
});
`)
    const seeded = spec({
      priorMessages: [{
        id: "message-1",
        role: "user",
        parts: [{ _tag: "Text", text: "Earlier context" }],
        streaming: false,
        createdAt: "2026-09-25T00:00:00.000Z"
      }],
      images: [{ id: "image-1", name: "x.png", mediaType: "image/png", data: "aGk=" }]
    })
    const events = [...await Effect.runPromise(
      makeClaudeAgentRuntime({ binary }).run(seeded, context).pipe(Stream.runCollect)
    )]
    expect(events).toContainEqual({ _tag: "Assistant", text: "seeded" })
  })

  it("sends only the new prompt when resuming a native session", async () => {
    const binary = await executable(`
let input=""; process.stdin.on("data",(chunk)=>input+=chunk); process.stdin.on("end",()=>{
 const text=JSON.parse(input.trim()).message.content[0].text;
 console.log(JSON.stringify({type:"stream_event",event:{type:"content_block_delta",delta:{type:"text_delta",text}}}));
 console.log(JSON.stringify({type:"result",is_error:false,usage:{}}));
});
`)
    const events = [...await Effect.runPromise(makeClaudeAgentRuntime({ binary }).run(spec({
      prompt: "new prompt",
      continuation: { runtimeId: "claude", endpointId, id: "prior-session" },
      priorMessages: [{
        id: "message-1",
        role: "user",
        parts: [{ _tag: "Text", text: "do not replay" }],
        streaming: false,
        createdAt: "2026-09-25T00:00:00.000Z"
      }]
    }), context).pipe(Stream.runCollect))]
    expect(events).toContainEqual({ _tag: "Assistant", text: "new prompt" })
  })

  it("rejects a zero exit without one valid result record", async () => {
    const binary = await executable("process.stdin.resume()")
    await expect(Effect.runPromise(
      makeClaudeAgentRuntime({ binary }).run(spec(), context).pipe(Stream.runCollect)
    )).rejects.toThrow("Claude CLI exited without a result")
  })

  it("normalizes Claude stream output without constructing a PI model runtime", async () => {
    const binary = await executable(`
process.stdin.resume()
console.log(JSON.stringify({type:"stream_event",event:{type:"content_block_delta",delta:{type:"text_delta",text:"Done"}}}))
console.log(JSON.stringify({type:"result",is_error:false,usage:{input_tokens:7,output_tokens:2}}))
`)
    const chunk = await Effect.runPromise(
      makeClaudeAgentRuntime({ binary }).run(spec(), context).pipe(Stream.runCollect)
    )
    const events = [...chunk]
    expect(events.map(({ _tag }) => _tag)).toEqual([
      "Started", "Assistant", "Usage", "Done"
    ])
    expect(events[0]).toMatchObject({ _tag: "Started", model: "anthropic/opus" })
  })
})

// A real child process drives HTTP MCP twice, consumes each result, and only
// then emits its final answer. No undocumented CLI control messages are used.
it("keeps the same native process alive for two tool rounds through final output", async () => {
  const binary = await executable(`
import { readFileSync } from "node:fs";
process.stdin.resume();
const configPath = process.argv[process.argv.indexOf("--mcp-config") + 1];
const config = JSON.parse(readFileSync(configPath, "utf8"));
const { url, headers } = config.mcpServers.jingler;
headers.Authorization = headers.Authorization.replace(/\\$\\{([^}]+)\\}/g, (_, key) => process.env[key]);
const values = [];
for (const [id, value] of [[1, "first"], [2, "second"]]) {
  const response = await fetch(url, { method: "POST", headers: { ...headers, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "echo", arguments: { value } } }) });
  const message = await response.json();
  if (message.result?.isError || !message.result?.content) throw new Error("missing real tool result");
  values.push(JSON.parse(message.result.content[0].text).actual);
}
console.log(JSON.stringify({type:"stream_event", event:{type:"content_block_delta", delta:{type:"text_delta", text: values.join("|")}}}));
console.log(JSON.stringify({type:"result",is_error:false,usage:{}}));
`)
  const registry = new ToolRegistry()
  const execute = vi.fn(async ({ value }: { value: string }) => ({ actual: value }))
  registry.register({
    id: "echo", version: "1", description: "Echo", input: Schema.Struct({ value: Schema.String }),
    roles: ["conversation"], modes: ["auto"], risk: "read", timeoutMs: 1000,
    outputBudget: 100, cancellable: true, idempotency: "safe", execute
  })
  const spawnProcess = vi.fn((binary: string, args: string[], options: SpawnOptionsWithoutStdio) => spawn(binary, args, options))
  const events = [...await Effect.runPromise(makeClaudeAgentRuntime({
    binary, spawnProcess, createToolRegistry: () => Effect.succeed(registry)
  }).run(spec(), context).pipe(Stream.runCollect))]
  expect(events).toContainEqual({ _tag: "Assistant", text: "first|second" })
  expect(events.at(-1)?._tag).toBe("Done")
  expect(execute).toHaveBeenCalledTimes(2)
  expect(spawnProcess).toHaveBeenCalledTimes(1)
  const args = spawnProcess.mock.calls[0]![1] as string[]
  expect(args).toContain("--strict-mcp-config")
  expect(args[args.indexOf("--tools") + 1]).toBe("")
  expect(args[args.indexOf("--allowedTools") + 1]).toBe("mcp__jingler__*")
  await expect(stat(args[args.indexOf("--mcp-config") + 1]!)).rejects.toThrow()
})

it("releases scoped registry resources if preparation fails", async () => {
  const release = vi.fn()
  const runtime = makeClaudeAgentRuntime({ createToolRegistry: () => Effect.gen(function* () {
    yield* Effect.acquireRelease(Effect.void, () => Effect.sync(release))
    return yield* Effect.fail(new AgentRuntimeError({ reason: "runtime", message: "registry preparation failed" }))
  }) })
  await expect(Effect.runPromise(runtime.run(spec(), context).pipe(Stream.runCollect))).rejects.toThrow("registry preparation failed")
  expect(release).toHaveBeenCalledOnce()
})

// Parser/process tests use a socket-free relay; the real two-round MCP test above
// retains end-to-end relay coverage.
const stubRelay = () => vi.spyOn(toolRelay, "startClaudeCliToolRelay").mockResolvedValueOnce({
  mcpConfigPath: "/tmp/unused-claude-protocol-fixture.json",
  environment: { JINGLER_CLAUDE_MCP_TOKEN: "fixture-token" },
  close: async () => {}
})

it("maps thinking, external tools and failure without a success terminal", async () => {
  stubRelay()
  const records = [
    { type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "consider" } } },
    { type: "assistant", message: { content: [
      { type: "thinking", thinking: "consider" },
      { type: "tool_use", id: "tool", name: "Read" },
      { type: "tool_use", id: "bridge", name: "mcp__jingler__echo" }
    ] } },
    { type: "result", is_error: true, result: "fixture failure" }
  ]
  const binary = await executable(`process.stdin.resume(); for (const record of ${JSON.stringify(records)}) console.log(JSON.stringify(record))`)
  const events = [...await Effect.runPromise(makeClaudeAgentRuntime({ binary }).run(spec(), context).pipe(Stream.runCollect))]
  expect(events.slice(1)).toEqual([
    { _tag: "Thinking", text: "consider", seconds: null, done: false },
    { _tag: "Thinking", text: "consider", seconds: null, done: true },
    { _tag: "ToolStart", id: "tool", name: "Read", target: null },
    { _tag: "Failed", message: "fixture failure" }
  ])
})

it.each([
  ["{broken", "invalid protocol"],
  ["[]", "invalid protocol"],
  [JSON.stringify({ type: "result" }), "malformed result"],
  ["x".repeat(4_194_305), "output bound"]
])("rejects malformed or oversized output (case %#)", async (line, error) => {
  stubRelay()
  const binary = await executable(`process.stdin.resume(); console.log(${JSON.stringify(line)})`)
  await expect(Effect.runPromise(makeClaudeAgentRuntime({ binary }).run(spec(), context).pipe(Stream.runCollect))).rejects.toThrow(error)
})

it("cancels a stream and reaps the owned process", async () => {
  stubRelay()
  const binary = await executable(`process.stdin.resume(); console.log(JSON.stringify({type:"system"})); setInterval(()=>{},1000)`)
  const children: ReturnType<typeof spawn>[] = []
  const spawnProcess = (command: string, args: string[], options: SpawnOptionsWithoutStdio) => {
    const child = spawn(command, args, options)
    children.push(child)
    return child
  }
  await Effect.runPromise(makeClaudeAgentRuntime({ binary, spawnProcess }).run(spec(), context).pipe(Stream.take(1), Stream.runDrain))
  expect(children).toHaveLength(1)
  expect(children[0]!.exitCode !== null || children[0]!.signalCode !== null).toBe(true)
})

it.each([
  ["2.1.281", {}, "unsupported"],
  ["not-a-version", {}, "unsupported"],
  ["2.1.282", { loggedIn: false }, "signed-out"],
  ["2.1.282", { loggedIn: true, authMethod: "apiKey", apiProvider: "firstParty" }, "signed-out"],
  ["2.1.282", { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" }, "ready"]
])("probes version %s and auth case %#", async (version, auth, status) => {
  const binary = await executable(`console.log(process.argv.includes("--version") ? ${JSON.stringify(version)} : ${JSON.stringify(JSON.stringify(auth))})`)
  const entry = await probeClaudeEndpoint({ binary, targetId: "device" })
  expect(entry.endpoint).toMatchObject({ status, targetId: "device", id: "device:claude:default" })
  expect(entry.models.every(model => model.selectable === (status === "ready"))).toBe(true)
})

it("reports missing Claude and malformed auth status", async () => {
  expect((await probeClaudeEndpoint({ binary: "/nonexistent/claude" })).endpoint.status).toBe("missing")
  const binary = await executable(`console.log(process.argv.includes("--version") ? "2.1.282" : "not-json")`)
  expect((await probeClaudeEndpoint({ binary })).endpoint.status).toBe("error")
})

it("keeps one result when completion races an interrupt", async () => {
  stubRelay()
  const binary = await executable(`process.stdin.resume(); console.log(JSON.stringify({type:"result",is_error:false,usage:{}}))`)
  const instance = makeClaudeAgentRuntime({ binary })
  let id = ""
  const events = [...await Effect.runPromise(instance.run(spec(), context).pipe(Stream.tap(event => {
    if (event._tag === "Started") id = event.sessionId
    return event._tag === "Done" ? instance.interrupt({ runtimeId: "claude", endpointId, id }, "desktop").pipe(Effect.ignore) : Effect.void
  }), Stream.runCollect))]
  expect(events.filter(event => event._tag === "Done")).toHaveLength(1)
})

it("lets interruption win before a result and reaps the process", async () => {
  stubRelay()
  const binary = await executable(`process.stdin.resume(); console.log(JSON.stringify({type:"system"})); setInterval(()=>{},1000)`)
  const instance = makeClaudeAgentRuntime({ binary })
  const seen: string[] = []
  await expect(Effect.runPromise(instance.run(spec(), context).pipe(Stream.tap(event => {
    seen.push(event._tag)
    return event._tag === "Started" ? instance.interrupt({ runtimeId: "claude", endpointId, id: event.sessionId }, "desktop") : Effect.void
  }), Stream.runDrain))).rejects.toThrow()
  expect(seen).toEqual(["Started"])
})
