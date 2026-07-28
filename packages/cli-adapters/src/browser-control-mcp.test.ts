import { describe, expect, it } from "vitest"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { buildBrowserControlMcp } from "./browser-control-mcp.js"
import type { BrowserControlPortShape } from "./browser-control-port.js"

/**
 * The agent-facing surface, exercised over a real (in-memory) MCP client so the
 * assertions are what a Claude turn would actually see: the tool list, that each
 * tool drives the port, and that a port failure comes back as an `isError`
 * result the model can read rather than a thrown protocol error.
 */
const stubPort = (over: Partial<BrowserControlPortShape> = {}): BrowserControlPortShape => ({
  navigate: async () => {},
  screenshot: async () => ({ pngBase64: "AAAA" }),
  click: async () => {},
  type: async () => {},
  readText: async () => ({ text: "" }),
  evaluate: async () => ({ result: "" }),
  waitForSelector: async () => {},
  ...over
})

const connect = async (port: BrowserControlPortShape): Promise<Client> => {
  const server = buildBrowserControlMcp(port).instance
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test", version: "1.0.0" })
  await client.connect(clientTransport)
  return client
}

type Block = { type: string; text?: string; data?: string; mimeType?: string }
const blocks = (res: unknown) => (res as { content: Array<Block> }).content

describe("buildBrowserControlMcp", () => {
  it("exposes the seven browser tools", async () => {
    const client = await connect(stubPort())
    const names = (await client.listTools()).tools.map((t) => t.name).sort()
    expect(names).toStrictEqual([
      "click",
      "evaluate",
      "navigate",
      "read_text",
      "screenshot",
      "type",
      "wait_for_selector"
    ])
  })

  it("navigate drives the port and confirms the URL", async () => {
    const seen: Array<string> = []
    const client = await connect(stubPort({ navigate: async (u) => void seen.push(u) }))
    const res = await client.callTool({
      name: "navigate",
      arguments: { url: "http://localhost:5173" }
    })
    expect(seen).toStrictEqual(["http://localhost:5173"])
    expect(res.isError).toBeFalsy()
    expect(blocks(res)[0]?.text).toContain("http://localhost:5173")
  })

  it("screenshot returns an image content block", async () => {
    const client = await connect(stubPort({ screenshot: async () => ({ pngBase64: "PNGDATA" }) }))
    const res = await client.callTool({ name: "screenshot", arguments: {} })
    const block = blocks(res)[0]!
    expect(block.type).toBe("image")
    expect(block.data).toBe("PNGDATA")
    expect(block.mimeType).toBe("image/png")
  })

  it("type passes selector and text through to the port", async () => {
    const seen: Array<[string, string]> = []
    const client = await connect(stubPort({ type: async (s, t) => void seen.push([s, t]) }))
    await client.callTool({ name: "type", arguments: { selector: "#email", text: "a@b.co" } })
    expect(seen).toStrictEqual([["#email", "a@b.co"]])
  })

  it("surfaces a port failure as an isError result, not a throw", async () => {
    const client = await connect(
      stubPort({
        click: async () => {
          throw new Error("No element matches selector: #nope")
        }
      })
    )
    const res = await client.callTool({ name: "click", arguments: { selector: "#nope" } })
    expect(res.isError).toBe(true)
    expect(blocks(res)[0]?.text).toContain("No element matches selector")
  })
})
