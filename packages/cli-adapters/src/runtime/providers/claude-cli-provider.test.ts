import { chmod, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Type, fauxProvider, type AssistantMessageEvent, type Context } from "@earendil-works/pi-ai"
import { describe, expect, it } from "vitest"
import {
  checkClaudeSubscription,
  claudeCliArguments,
  createClaudeCliStreamSimple
} from "./claude-cli-provider.js"

const model = fauxProvider({ provider: "anthropic", api: "anthropic-messages" }).getModel()
const context: Context = {
  systemPrompt: "Use only the supplied tools.",
  messages: [{ role: "user", content: "Inspect package.json", timestamp: 1 }],
  tools: [{
    name: "workspace_read_file",
    description: "Read one workspace file.",
    parameters: Type.Object({ path: Type.String() })
  }]
}

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
    const first = await stream(liveModel, liveContext, { signal: AbortSignal.timeout(60_000) }).result()
    expect(first.stopReason).toBe("toolUse")
    const call = first.content.find((part) => part.type === "toolCall")!
    expect(call?.name).toBe("probe_echo")
    const second = await stream(liveModel, { ...liveContext, messages: [
      ...liveContext.messages, first,
      { role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: "JINGLER_TOOL_RESULT_73" }], isError: false, timestamp: 2 }
    ] }, { signal: AbortSignal.timeout(60_000) }).result()
    expect(second.stopReason).toBe("stop")
    expect(second.content.filter((part) => part.type === "text").map((part) => part.text).join(""))
      .toContain("JINGLER_TOOL_RESULT_73")
  }, 130_000)

  it("uses stream-json with only the authenticated Jingler MCP tools", () => {
    const args = claudeCliArguments(model, context, { reasoning: "high" }, "/tmp/mcp.json")
    expect(args).toContain("stream-json")
    expect(args).toContain("--strict-mcp-config")
    expect(args).toContain("mcp__jingler__*")
    expect(args).toContain("--no-session-persistence")
    expect(args).not.toContain("--max-turns")
    expect(args).toContain("--setting-sources")
    expect(args).toContain("")
    expect(args).toContain("high")
  })

  it("requires Claude to use a named Jingler MCP service before other work", () => {
    const mcpContext: Context = {
      ...context,
      tools: [...(context.tools ?? []), {
        name: "mcp_search",
        description: "Discover configured MCP capabilities. Servers: paper",
        parameters: Type.Object({ query: Type.String() })
      }]
    }
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
})
