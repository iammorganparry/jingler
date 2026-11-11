import { chmod, mkdtemp, writeFile } from "node:fs/promises"
import { latestClaudeCliRateLimits, resetClaudeCliRateLimits } from "./claude-cli-rate-limits.js"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Type, fauxProvider, normalizeContext, type AssistantMessageEvent, type Context } from "@earendil-works/pi-ai"
import { describe, expect, it } from "vitest"
import {
  checkClaudeSubscription,
  claudeCliArguments,
  readClaudeLogin,
  createClaudeCliStreamSimple,
  transcriptContent,
  TOOLS_FINISHED_NOTE
} from "./claude-cli-provider.js"

const model = fauxProvider({ provider: "anthropic", api: "anthropic-messages" }).getModel()
const rawContext: Context = {
  systemPrompt: "Use only the supplied tools.",
  messages: [{ role: "user", content: "Inspect package.json", timestamp: 1 }],
  tools: [{
    name: "workspace_read_file",
    description: "Read one workspace file.",
    parameters: Type.Object({ path: Type.String() })
  }]
}
const context = normalizeContext(rawContext)

const executable = async (body: string): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "jingler-claude-cli-"))
  const file = join(directory, "claude-fixture.mjs")
  await writeFile(file, `#!/usr/bin/env node\n${body}`)
  await chmod(file, 0o755)
  return file
}

const collect = async (stream: AsyncIterable<AssistantMessageEvent>) => {
  const events: AssistantMessageEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}

describe("Claude CLI provider relay", () => {
  it.runIf(process.env.JINGLER_CLAUDE_LIVE === "1")("returns a live tool selection to Pi and consumes Pi's result on the next turn", async () => {
    const liveModel = { ...model, id: "haiku" }
    const liveContext: Context = {
      systemPrompt: "Use only the supplied tools. Call probe_echo once, then reply with its returned word.",
      tools: [{ name: "probe_echo", description: "Return a secret test word.", parameters: Type.Object({}) }],
      messages: [{ role: "user", content: "Call probe_echo and reply with its word.", timestamp: 1 }]
    }
    const stream = createClaudeCliStreamSimple()
    const first = await stream(liveModel, normalizeContext(liveContext), { signal: AbortSignal.timeout(60_000) }).result()
    expect(first.stopReason).toBe("toolUse")
    const call = first.content.find((part) => part.type === "toolCall")!
    expect(call?.name).toBe("probe_echo")
    const second = await stream(liveModel, normalizeContext({ ...liveContext, messages: [
      ...liveContext.messages, first,
      { role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: "JINGLER_TOOL_RESULT_73" }], isError: false, timestamp: 2 }
    ] }), { signal: AbortSignal.timeout(60_000) }).result()
    expect(second.stopReason).toBe("stop")
    expect(second.content.filter((part) => part.type === "text").map((part) => part.text).join(""))
      .toContain("JINGLER_TOOL_RESULT_73")
  }, 130_000)

  it("uses stream-json with only the Jingler MCP tools unless artifacts are allowed", () => {
    const args = claudeCliArguments(model, context, { reasoning: "high" }, "/tmp/mcp.json")
    const withArtifacts = claudeCliArguments(model, context, {}, "/tmp/mcp.json", true)
    expect(args[args.indexOf("--tools") + 1]).toBe("")
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("mcp__jingler__*")
    expect(withArtifacts[withArtifacts.indexOf("--tools") + 1]).toBe("Artifact,Read")
    expect(withArtifacts[withArtifacts.indexOf("--allowedTools") + 1]).toBe("mcp__jingler__* Artifact")
    expect(args).toContain("stream-json")
    expect(args).toContain("--strict-mcp-config")
    expect(args).toContain("--no-session-persistence")
    expect(args).not.toContain("--max-turns")
    expect(args).toContain("--setting-sources")
    expect(args).toContain("")
    expect(args).toContain("high")
  })

  it("loads claude.ai connectors with user settings when a connector overlay is given", () => {
    const overlay = JSON.stringify({ disableAllHooks: true, deniedMcpServers: [{ serverName: "obsidian" }] })
    const args = claudeCliArguments(model, context, {}, "/tmp/mcp.json", false, overlay)
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("user")
    expect(args[args.indexOf("--settings") + 1]).toBe(overlay)
    expect(args).not.toContain("--strict-mcp-config")
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("mcp__jingler__* mcp__claude_ai_* ToolSearch")
    expect(args[args.indexOf("--tools") + 1]).toBe("ToolSearch")
    expect(args[args.indexOf("--mcp-config") + 1]).toBe("/tmp/mcp.json")
  })

  it("requires Claude to use a named Jingler MCP service before other work", () => {
    const mcpContext = normalizeContext({
      ...rawContext,
      tools: [...(rawContext.tools ?? []), {
        name: "mcp_search",
        description: "Discover configured MCP capabilities. Servers: paper",
        parameters: Type.Object({ query: Type.String() })
      }]
    })
    const args = claudeCliArguments(model, mcpContext, {}, "/tmp/mcp.json")
    const prompt = args[args.indexOf("--system-prompt") + 1]
    expect(prompt).toContain("When the user asks to use or inspect a named service")
    expect(prompt).toContain("call mcp_search for that service before taking other action")
  })

  it("accepts only first-party Claude.ai subscription authentication", async () => {
    const valid = await executable(`
console.log(JSON.stringify({loggedIn:true,authMethod:"claude.ai",apiProvider:"firstParty",subscriptionType:"max"}))
`)
    await expect(checkClaudeSubscription(valid, process.env)).resolves.toBeUndefined()

    const api = await executable(`
console.log(JSON.stringify({loggedIn:true,authMethod:"api_key",apiProvider:"firstParty",subscriptionType:"max"}))
`)
    await expect(checkClaudeSubscription(api, process.env)).rejects.toThrow(
      "not authenticated with a subscription"
    )
  })

  it.each(["pro", "max", "team", "enterprise"])("accepts a %s subscription login", async (plan) => {
    const login = await executable(`
console.log(JSON.stringify({loggedIn:true,authMethod:"claude.ai",apiProvider:"firstParty",subscriptionType:"${plan}"}))
`)
    await expect(checkClaudeSubscription(login, process.env)).resolves.toBeUndefined()
  })

  it("confirms the api billing route for Enterprise and Console logins instead of failing", async () => {
    // Shape of `claude auth status` (Claude Code 2.1.x) for an Enterprise seat.
    const enterprise = await executable(`
console.log(JSON.stringify({loggedIn:true,authMethod:"claude.ai",apiProvider:"firstParty",orgName:"Acme",subscriptionType:"enterprise"}))
`)
    await expect(readClaudeLogin(enterprise, process.env)).resolves.toEqual({
      route: "api",
      planLabel: "Enterprise · API pricing"
    })
    const consoleLogin = await executable(`
console.log(JSON.stringify({loggedIn:true,authMethod:"api_key",apiProvider:"firstParty",apiKeySource:"/login managed key"}))
`)
    await expect(readClaudeLogin(consoleLogin, process.env)).resolves.toMatchObject({ route: "api" })
    const max = await executable(`
console.log(JSON.stringify({loggedIn:true,authMethod:"claude.ai",apiProvider:"firstParty",subscriptionType:"max"}))
`)
    await expect(readClaudeLogin(max, process.env)).resolves.toMatchObject({ route: "subscription" })
  })

  it("distinguishes a missing CLI from a signed-out CLI", async () => {
    await expect(checkClaudeSubscription("/nonexistent/claude", process.env)).rejects.toThrow(
      "Claude CLI is not installed"
    )
  })

  it("does not create a relay when cancellation arrives during authentication", async () => {
    const controller = new AbortController()
    let relayStarted = false
    const stream = createClaudeCliStreamSimple({
      checkAuth: async () => {
        await new Promise((resolve) => setTimeout(resolve, 100))
      },
      startToolRelay: async () => {
        relayStarted = true
        return {
          mcpConfigPath: "/tmp/mcp.json",
          toolCall: new Promise(() => {}),
          close: async () => {}
        }
      }
    })(model, context, { signal: controller.signal })
    setTimeout(() => controller.abort(), 20)
    const events = await collect(stream)
    expect(relayStarted).toBe(false)
    const error = events.at(-1)
    expect(error?.type === "error" ? error.reason : null).toBe("aborted")
  })

  it("maps Claude text deltas and usage into the pi provider stream", async () => {
    const binary = await executable(`
process.stdin.resume()
const leaked = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_BASE_URL || process.env.CLAUDE_CODE_USE_BEDROCK
console.log(JSON.stringify({type:"stream_event",event:{type:"content_block_delta",index:0,delta:{type:"text_delta",text:"Done"}}}))
console.log(JSON.stringify({type:"result",subtype:leaked?"error":"success",is_error:Boolean(leaked),result:leaked?"API route leaked":"Done",usage:{input_tokens:7,output_tokens:2,cache_read_input_tokens:3}}))
`)
    const stream = createClaudeCliStreamSimple({
      binary,
      environment: {
        ...process.env,
        ANTHROPIC_API_KEY: "must-not-reach-child",
        ANTHROPIC_BASE_URL: "https://api.example.test",
        CLAUDE_CODE_USE_BEDROCK: "1"
      },
      checkAuth: async () => {},
      startToolRelay: async () => ({
        mcpConfigPath: "/tmp/mcp.json",
        toolCall: new Promise(() => {}),
        close: async () => {}
      })
    })(model, context)
    const events = await collect(stream)
    expect(events.map(({ type }) => type)).toEqual([
      "start", "text_start", "text_delta", "text_end", "done"
    ])
    const done = events.at(-1)
    expect(done?.type === "done" ? done.message.usage : null).toMatchObject({
      input: 7,
      output: 2,
      cacheRead: 3,
      totalTokens: 12,
      cost: { total: 0 }
    })
  })

  it("runs a tool the CLI rejected as missing through pi instead of stalling the turn", async () => {
    // Regression: the CLI answered "No such tool available" for tools pi had
    // offered (command_execute, command_inspect, subagent); the call never
    // reached the relay and the model gave up on its shell.
    const binary = await executable(`
process.stdin.resume()
console.log(JSON.stringify({type:"system",subtype:"init",tools:["mcp__jingler__workspace_read_file"]}))
console.log(JSON.stringify({type:"assistant",message:{content:[{type:"tool_use",id:"toolu_9",name:"mcp__jingler__command_execute",input:{command:"git status"}}]}}))
console.log(JSON.stringify({type:"user",message:{content:[{type:"tool_result",tool_use_id:"toolu_9",is_error:true,content:"<tool_use_error>Error: No such tool available: mcp__jingler__command_execute</tool_use_error>"}]}}))
console.log(JSON.stringify({type:"stream_event",event:{type:"content_block_delta",index:0,delta:{type:"text_delta",text:"My shell is gone."}}}))
console.log(JSON.stringify({type:"result",subtype:"success",is_error:false,result:"My shell is gone.",usage:{}}))
setInterval(() => {}, 1000)
`)
    const stream = createClaudeCliStreamSimple({
      binary,
      checkAuth: async () => {},
      startToolRelay: async () => ({
        mcpConfigPath: "/tmp/mcp.json",
        toolCall: new Promise(() => {}),
        close: async () => {}
      })
    })(model, normalizeContext({
      ...rawContext,
      tools: [{ name: "command_execute", description: "Run a command.", parameters: { type: "object", properties: {} } } as never]
    }))
    const events = await collect(stream)
    const done = events.at(-1)
    expect(done?.type === "done" ? done.reason : null).toBe("toolUse")
    const end = events.find((event) => event.type === "toolcall_end")
    expect(end?.type === "toolcall_end" ? end.toolCall : null).toMatchObject({
      name: "command_execute",
      arguments: { command: "git status" }
    })
    expect(events.some((event) => event.type === "text_delta")).toBe(false)
  })

  it("echoes a published artifact URL into the reply so it survives the CLI being stopped", async () => {
    const binary = await executable(`
process.stdin.resume()
console.log(JSON.stringify({type:"assistant",message:{content:[{type:"tool_use",id:"art",name:"Artifact",input:{file_path:"/w/p.html"}}]}}))
console.log(JSON.stringify({type:"user",message:{content:[{type:"tool_result",tool_use_id:"art",content:"Published /w/p.html at https://claude.ai/artifact/N8nThbQe6ZyN8PewWJdfg9 (Version 1, version id 1)"}]}}))
console.log(JSON.stringify({type:"user",message:{content:[{type:"tool_result",tool_use_id:"r",content:"plain read output"}]}}))
console.log(JSON.stringify({type:"result",subtype:"success",is_error:false,result:"",usage:{}}))
`)
    const stream = createClaudeCliStreamSimple({
      binary,
      artifacts: true,
      checkAuth: async () => {},
      startToolRelay: async () => ({ mcpConfigPath: "/tmp/mcp.json", toolCall: new Promise(() => {}), close: async () => {} })
    })(model, context)
    const events = await collect(stream)
    const text = events.flatMap((event) => event.type === "text_delta" ? [event.delta] : []).join("")
    expect(text.trim()).toBe("Published artifact: https://claude.ai/artifact/N8nThbQe6ZyN8PewWJdfg9")
  })

  it("hands the CLI's rate-limit report to the Usage panel through the pi bridge", async () => {
    resetClaudeCliRateLimits()
    const binary = await executable(`
process.stdin.resume()
console.log(JSON.stringify({type:"rate_limit_event",rate_limit_info:{status:"allowed",unifiedWindows:{seven_day:{utilization:0.5,resetsAt:1790992800}}}}))
console.log(JSON.stringify({type:"result",subtype:"success",is_error:false,result:"Done",usage:{}}))
`)
    const stream = createClaudeCliStreamSimple({
      binary,
      checkAuth: async () => {},
      startToolRelay: async () => ({
        mcpConfigPath: "/tmp/mcp.json",
        toolCall: new Promise(() => {}),
        close: async () => {}
      })
    })(model, context)
    expect((await collect(stream)).at(-1)?.type).toBe("done")
    expect(latestClaudeCliRateLimits()?.windows.seven_day).toEqual({ utilization: 0.5, resetsAt: 1790992800 })
    resetClaudeCliRateLimits()
  })

  it("gives pi the last request's usage, which it reads as context", async () => {
    const binary = await executable(`
process.stdin.resume()
console.log(JSON.stringify({type:"result",subtype:"success",is_error:false,result:"Done",usage:{input_tokens:34,output_tokens:536,cache_read_input_tokens:96204,cache_creation_input_tokens:14417,iterations:[{input_tokens:8,output_tokens:54,cache_read_input_tokens:28125,cache_creation_input_tokens:148}]}}))
`)
    const stream = createClaudeCliStreamSimple({
      binary,
      checkAuth: async () => {},
      startToolRelay: async () => ({
        mcpConfigPath: "/tmp/mcp.json",
        toolCall: new Promise(() => {}),
        close: async () => {}
      })
    })(model, context)
    const done = (await collect(stream)).at(-1)
    expect(done?.type === "done" ? done.message.usage : null).toMatchObject({
      input: 8,
      output: 54,
      cacheRead: 28_125,
      cacheWrite: 148,
      totalTokens: 28_335
    })
  })

  it("rejects malformed critical stream events", async () => {
    const binary = await executable(`
process.stdin.resume()
console.log(JSON.stringify({type:"stream_event",event:{type:"content_block_delta",index:0,delta:{type:"text_delta",text:42}}}))
console.log(JSON.stringify({type:"result",subtype:"success",is_error:false,result:"ignored"}))
`)
    const events = await collect(createClaudeCliStreamSimple({
      binary,
      checkAuth: async () => {},
      startToolRelay: async () => ({
        mcpConfigPath: "/tmp/mcp.json",
        toolCall: new Promise(() => {}),
        close: async () => {}
      })
    })(model, context))
    const error = events.at(-1)
    expect(error?.type === "error" ? error.error.errorMessage : null)
      .toContain("malformed critical stream event")
  })

  it("closes the relay when process creation fails", async () => {
    let relayClosed = false
    const stream = createClaudeCliStreamSimple({
      checkAuth: async () => {},
      startToolRelay: async () => ({
        mcpConfigPath: "/tmp/mcp.json",
        toolCall: new Promise(() => {}),
        close: async () => {
          relayClosed = true
        }
      }),
      spawnProcess: (() => {
        throw new Error("spawn failed")
      }) as typeof import("node:child_process").spawn
    })(model, context)
    const events = await collect(stream)
    expect(events.at(-1)?.type).toBe("error")
    expect(relayClosed).toBe(true)
  })

  it("escalates cancellation when Claude ignores SIGINT", async () => {
    const binary = await executable(`
process.on("SIGINT", () => {})
process.stdin.resume()
console.log(JSON.stringify({type:"stream_event",event:{type:"content_block_delta",index:0,delta:{type:"text_delta",text:"ready"}}}))
setInterval(() => {}, 1000)
`)
    const controller = new AbortController()
    const stream = createClaudeCliStreamSimple({
      binary,
      checkAuth: async () => {},
      startToolRelay: async () => ({
        mcpConfigPath: "/tmp/mcp.json",
        toolCall: new Promise(() => {}),
        close: async () => {}
      })
    })(model, context, { signal: controller.signal })
    const started = Date.now()
    const events: AssistantMessageEvent[] = []
    for await (const event of stream) {
      events.push(event)
      if (event.type === "text_delta") controller.abort()
    }
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_900)
    expect(Date.now() - started).toBeLessThan(3_500)
    expect(events.at(-1)?.type).toBe("error")
    const error = events.at(-1)
    expect(error?.type === "error" ? error.reason : null).toBe("aborted")
  })

  it("turns a relayed MCP selection into a pi tool call without executing it", async () => {
    const binary = await executable("process.stdin.resume(); setInterval(() => {}, 1000)")
    const stream = createClaudeCliStreamSimple({
      binary,
      checkAuth: async () => {},
      startToolRelay: async () => ({
        mcpConfigPath: "/tmp/mcp.json",
        toolCall: Promise.resolve({
          id: "call-1",
          name: "workspace_read_file",
          arguments: { path: "package.json" }
        }),
        close: async () => {}
      })
    })(model, context)
    const events = await collect(stream)
    expect(events.map(({ type }) => type)).toEqual([
      "start", "toolcall_start", "toolcall_delta", "toolcall_end", "done"
    ])
    const tool = events.find(({ type }) => type === "toolcall_end")
    expect(tool?.type === "toolcall_end" ? tool.toolCall : null).toEqual({
      type: "toolCall",
      id: "call-1",
      name: "workspace_read_file",
      arguments: { path: "package.json" }
    })
    const done = events.at(-1)
    expect(done?.type === "done" ? done.reason : null).toBe("toolUse")
  })

  it("runs a tool call the model typed as text, and drops the result it made up", async () => {
    const delta = (text: string) => JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }
    })
    const lines = [
      "Reading it.\n\n<br>",
      '<jingler-tool-call id="x" name="workspace_read_file">\n{"path":"package.json"}\n</jingler-tool-call>',
      '<jingler-tool-result id="x">made up</jingler-tool-result>'
    ].map((text) => `console.log(${JSON.stringify(delta(text))})`).join("\n")
    const binary = await executable(`process.stdin.resume()\n${lines}\nsetInterval(() => {}, 1000)`)
    const events = await collect(createClaudeCliStreamSimple({
      binary,
      checkAuth: async () => {},
      startToolRelay: async () => ({ mcpConfigPath: "/tmp/mcp.json", toolCall: new Promise(() => {}), close: async () => {} })
    })(model, context))
    const text = events.flatMap((event) => event.type === "text_delta" ? [event.delta] : []).join("")
    expect(text).toBe("Reading it.\n\n")
    const tool = events.find(({ type }) => type === "toolcall_end")
    expect(tool?.type === "toolcall_end" ? tool.toolCall : null).toMatchObject({
      name: "workspace_read_file",
      arguments: { path: "package.json" }
    })
    const done = events.at(-1)
    expect(done?.type === "done" ? done.reason : null).toBe("toolUse")
  })

  it("replays past tool use as plain records, never as markup to copy", () => {
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
    const replay = normalizeContext({
      ...rawContext,
      messages: [
        ...rawContext.messages,
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "c1", name: "workspace_read_file", arguments: { path: "a.lua" } },
            { type: "toolCall", id: "c2", name: "workspace_read_file", arguments: { path: "b.lua" } }
          ],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage,
          stopReason: "toolUse",
          timestamp: 2
        },
        { role: "toolResult", toolCallId: "c2", toolName: "workspace_read_file", content: [{ type: "text", text: "b contents" }], isError: false, timestamp: 3 },
        { role: "toolResult", toolCallId: "c1", toolName: "workspace_read_file", content: [{ type: "text", text: "no such file" }], isError: true, timestamp: 4 }
      ]
    })
    const text = transcriptContent(replay).flatMap((part) => part.type === "text" ? [part.text] : []).join("\n")
    expect(text).toContain('Call #1: called workspace_read_file with {"path":"a.lua"}. This call already ran.')
    expect(text).toContain('Call #2: called workspace_read_file with {"path":"b.lua"}. This call already ran.')
    expect(text).toContain("Call #1: workspace_read_file finished with an error. Its output:\nno such file")
    expect(text).toContain("Call #2: workspace_read_file finished. Its output:\nb contents")
    expect(text.endsWith(TOOLS_FINISHED_NOTE)).toBe(true)
    expect(text).not.toContain("jingler-tool-")
  })

  it("only ever grows the replay at the end, so the prompt-cache prefix survives every call", () => {
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
    const call = (id: string, timestamp: number) => ({
      role: "assistant" as const,
      content: [{ type: "toolCall" as const, id, name: "workspace_read_file", arguments: { path: `${id}.ts` } }],
      api: model.api, provider: model.provider, model: model.id, usage, stopReason: "toolUse" as const, timestamp
    })
    const result = (id: string, timestamp: number) => ({
      role: "toolResult" as const, toolCallId: id, toolName: "workspace_read_file",
      content: [{ type: "text" as const, text: `${id} contents` }], isError: false, timestamp
    })
    const steps = [
      [call("c1", 2), result("c1", 3)],
      [call("c2", 4), result("c2", 5)],
      [{ ...call("c3", 6), content: [{ type: "text" as const, text: "done" }], stopReason: "stop" as const }],
      [{ role: "user" as const, content: "next", timestamp: 7 }]
    ]
    let messages = [...rawContext.messages]
    let previous = transcriptContent(normalizeContext({ ...rawContext, messages }))
    for (const step of steps) {
      messages = [...messages, ...step]
      const next = transcriptContent(normalizeContext({ ...rawContext, messages }))
      expect(next.slice(0, previous.length)).toEqual(previous)
      previous = next
    }
  })

  it("records the request's usage on a turn that ends in a tool call", async () => {
    const binary = await executable(`process.stdin.resume(); console.log(${JSON.stringify(JSON.stringify(JSON.parse('{"type":"stream_event","event":{"type":"message_delta","usage":{"input_tokens":9,"output_tokens":236,"cache_read_input_tokens":26773,"cache_creation_input_tokens":2968}}}')))}); setInterval(() => {}, 1000)`)
    const stream = createClaudeCliStreamSimple({
      binary,
      checkAuth: async () => {},
      startToolRelay: async () => ({
        mcpConfigPath: "/tmp/mcp.json",
        toolCall: new Promise((resolve) => setTimeout(() => resolve({
          id: "call-1",
          name: "workspace_read_file",
          arguments: { path: "package.json" }
        }), 2000)),
        close: async () => {}
      })
    })(model, context)
    const done = (await collect(stream)).at(-1)
    expect(done?.type === "done" ? done.reason : null).toBe("toolUse")
    expect(done?.type === "done" ? done.message.usage : null).toMatchObject({
      input: 9, output: 236, cacheRead: 26773, cacheWrite: 2968, totalTokens: 29986
    })
  })
})
