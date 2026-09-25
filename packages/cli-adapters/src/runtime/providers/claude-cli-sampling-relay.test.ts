import { readFile, stat } from "node:fs/promises"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { Type, type Tool } from "@earendil-works/pi-ai"
import { describe, expect, it } from "vitest"
import { startClaudeCliToolRelay } from "./claude-cli-sampling-relay.js"

const tools: ReadonlyArray<Tool> = [
  {
    name: "workspace_read_file",
    description: "Read one workspace file.",
    parameters: Type.Object({ path: Type.String() })
  },
  {
    name: "jingler_ask_question",
    description: "Ask the operator a question.",
    parameters: Type.Unsafe({ properties: { question: { type: "string" } } })
  }
]

describe("Claude CLI tool relay", () => {
  it("lists tools and captures one call without executing it", async () => {
    const relay = await startClaudeCliToolRelay(tools)
    expect((await stat(relay.mcpConfigPath)).mode & 0o777).toBe(0o600)
    const config = JSON.parse(await readFile(relay.mcpConfigPath, "utf8")) as {
      mcpServers: { jingler: { url: string; headers: Record<string, string> } }
    }
    const transport = new StreamableHTTPClientTransport(
      new URL(config.mcpServers.jingler.url),
      { requestInit: { headers: config.mcpServers.jingler.headers } }
    )
    const client = new Client({ name: "relay-test", version: "1.0.0" })
    try {
      await client.connect(transport)
      const listed = (await client.listTools()).tools
      expect(listed.map(({ name }) => name)).toEqual([
        "workspace_read_file",
        "jingler_ask_question"
      ])
      expect(listed.every(({ inputSchema }) => inputSchema.type === "object")).toBe(true)
      await client.callTool({
        name: "workspace_read_file",
        arguments: { path: "package.json" }
      })
      await expect(relay.toolCall).resolves.toMatchObject({
        name: "workspace_read_file",
        arguments: { path: "package.json" }
      })
    } finally {
      await client.close()
      await relay.close()
    }
    await expect(stat(relay.mcpConfigPath)).rejects.toThrow()
  })
})
