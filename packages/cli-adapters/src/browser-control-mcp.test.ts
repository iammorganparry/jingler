import { describe, expect, it } from "vitest"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { buildBrowserControlMcp } from "./browser-control-mcp.js"
import type { BrowserControlSessionPortShape } from "./browser-control-port.js"

/**
 * The agent-facing surface, exercised over a real (in-memory) MCP client so the
 * assertions are what a Claude turn would actually see: the tool list, that each
 * tool drives the port, and that a port failure comes back as an `isError`
 * result the model can read rather than a thrown protocol error.
 */
const stubPort = (
  over: Partial<BrowserControlSessionPortShape> = {}
): BrowserControlSessionPortShape => ({
  navigate: async () => {},
  screenshot: async () => ({ pngBase64: "AAAA" }),
  click: async () => {},
  type: async () => {},
  readText: async () => ({ text: "" }),
  evaluate: async () => ({ result: "" }),
  waitForSelector: async () => {},
  ...over
})

const connect = async (port: BrowserControlSessionPortShape): Promise<Client> => {
  const server = buildBrowserControlMcp(port)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test", version: "1.0.0" })
  await client.connect(clientTransport)
  return client
}

type Block = { type: string; text?: string; data?: string; mimeType?: string }
const blocks = (res: unknown) => (res as { content: Array<Block> }).content

describe("buildBrowserControlMcp", () => {
  it("exposes exactly the seven described browser tools through the standard MCP API", async () => {
    const client = await connect(stubPort())
    const tools = (await client.listTools()).tools
    const names = tools.map((tool) => tool.name).sort()
    expect(names).toStrictEqual([
      "click",
      "evaluate",
      "navigate",
      "read_text",
      "screenshot",
      "type",
      "wait_for_selector"
    ])
    expect(tools.every((tool) => typeof tool.description === "string" && tool.description.length > 0)).toBe(
      true
    )
  })

  it("delegates every tool to the BrowserControlPort and preserves its result", async () => {
    const seen: Array<string> = []
    const client = await connect({
      navigate: async (url) => {
        seen.push(`navigate:${url}`)
      },
      screenshot: async () => {
        seen.push("screenshot")
        return { pngBase64: "PNGDATA" }
      },
      click: async (selector) => {
        seen.push(`click:${selector}`)
      },
      type: async (selector, text) => {
        seen.push(`type:${selector}:${text}`)
      },
      readText: async () => {
        seen.push("read_text")
        return { text: "Visible page text" }
      },
      evaluate: async (expression) => {
        seen.push(`evaluate:${expression}`)
        return { result: "Preview title" }
      },
      waitForSelector: async (selector, timeoutMs) => {
        seen.push(`wait_for_selector:${selector}:${timeoutMs}`)
      }
    })

    const navigate = await client.callTool({
      name: "navigate",
      arguments: { url: "http://localhost:5173" }
    })
    const screenshot = await client.callTool({ name: "screenshot", arguments: {} })
    const click = await client.callTool({ name: "click", arguments: { selector: "#submit" } })
    const type = await client.callTool({
      name: "type",
      arguments: { selector: "#email", text: "a@b.co" }
    })
    const readText = await client.callTool({ name: "read_text", arguments: {} })
    const evaluate = await client.callTool({
      name: "evaluate",
      arguments: { expression: "document.title" }
    })
    const wait = await client.callTool({
      name: "wait_for_selector",
      arguments: { selector: ".ready" }
    })

    expect(seen).toStrictEqual([
      "navigate:http://localhost:5173",
      "screenshot",
      "click:#submit",
      "type:#email:a@b.co",
      "read_text",
      "evaluate:document.title",
      "wait_for_selector:.ready:10000"
    ])
    expect(blocks(navigate)[0]?.text).toContain("http://localhost:5173")
    expect(blocks(screenshot)[0]).toStrictEqual({
      type: "image",
      data: "PNGDATA",
      mimeType: "image/png"
    })
    expect(blocks(click)[0]?.text).toBe("Clicked #submit.")
    expect(blocks(type)[0]?.text).toBe("Typed into #email.")
    expect(blocks(readText)[0]?.text).toBe("Visible page text")
    expect(blocks(evaluate)[0]?.text).toBe("Preview title")
    expect(blocks(wait)[0]?.text).toBe("Found .ready.")
  })

  it("surfaces every port failure as a readable MCP error without crashing the server", async () => {
    const reject = async (): Promise<never> => {
      throw new Error("Preview WebContentsView unavailable")
    }
    const client = await connect({
      navigate: reject,
      screenshot: reject,
      click: reject,
      type: reject,
      readText: reject,
      evaluate: reject,
      waitForSelector: reject
    })
    const calls = [
      { name: "navigate", arguments: { url: "http://localhost:5173" } },
      { name: "screenshot", arguments: {} },
      { name: "click", arguments: { selector: "#nope" } },
      { name: "type", arguments: { selector: "#email", text: "a@b.co" } },
      { name: "read_text", arguments: {} },
      { name: "evaluate", arguments: { expression: "document.title" } },
      { name: "wait_for_selector", arguments: { selector: ".ready" } }
    ]

    const results = await Promise.all(calls.map((call) => client.callTool(call)))
    results.forEach((result, index) => {
      expect(result.isError, calls[index]?.name).toBe(true)
      expect(blocks(result)[0]?.text, calls[index]?.name).toBe(
        "Error: Preview WebContentsView unavailable"
      )
    })

    expect((await client.listTools()).tools).toHaveLength(7)
  })

  it("returns validation failures as MCP errors without invoking the port", async () => {
    let called = false
    const client = await connect(
      stubPort({
        navigate: async () => {
          called = true
        }
      })
    )
    const result = await client.callTool({
      name: "navigate",
      arguments: { url: 42 }
    })

    expect(result.isError).toBe(true)
    expect(blocks(result)[0]?.text).toContain("Input validation error")
    expect(called).toBe(false)
    expect((await client.listTools()).tools).toHaveLength(7)
  })
})
