import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { BrowserControlPortShape } from "./browser-control-port.js"

/** The MCP server the model sees; tools appear as `mcp__jingler-browser__*`. */
export const BROWSER_MCP_NAME = "jingler-browser"

const errText = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] })
const failed = (cause: unknown) => ({
  content: [{ type: "text" as const, text: `Error: ${errText(cause)}` }],
  isError: true
})

/**
 * A standard MCP server with the temporary structural fields expected by the
 * Claude SDK's in-process transport. Keeping that compatibility here lets the
 * existing Claude adapter consume the server while registration and callers
 * depend only on the provider-neutral MCP SDK.
 */
class BrowserControlMcpServer extends McpServer {
  readonly type: "sdk" = "sdk"
  readonly name = BROWSER_MCP_NAME
  readonly instance: McpServer = this
}

/**
 * Build the in-process browser-control MCP server for an agent run.
 *
 * Every tool drives Jingler's OWN embedded browser (the Preview dock's
 * `WebContentsView`) via the `BrowserControlPort`, so QA happens in the browser
 * the operator is watching rather than a headless Chrome the agent spawned. The
 * server runs in-process in the main process next to `PreviewViewService`, so
 * there is no socket, port or token to guard — the capability never leaves the
 * process.
 */
export const buildBrowserControlMcp = (port: BrowserControlPortShape) => {
  const server = new BrowserControlMcpServer({
    name: BROWSER_MCP_NAME,
    version: "1.0.0"
  })

  server.registerTool(
    "navigate",
    {
      description:
        "Open a URL in Jingler's in-app browser (the one the operator is watching) and reveal it. Use this to QA a preview or dev-server URL — prefer it over the browser-use CLI, which spawns a browser the operator can't see.",
      inputSchema: {
        url: z.string().describe("An http(s) URL, e.g. the preview/dev-server address.")
      }
    },
    async ({ url }) => {
      try {
        await port.navigate(url)
        return ok(`Opened ${url} in the in-app browser.`)
      } catch (cause) {
        return failed(cause)
      }
    }
  )

  server.registerTool(
    "screenshot",
    {
      description:
        "Take a PNG screenshot of the in-app browser's current page — your eyes on what the operator sees."
    },
    async () => {
      try {
        const { pngBase64 } = await port.screenshot()
        return { content: [{ type: "image" as const, data: pngBase64, mimeType: "image/png" }] }
      } catch (cause) {
        return failed(cause)
      }
    }
  )

  server.registerTool(
    "click",
    {
      description: "Click the first element matching a CSS selector in the in-app browser.",
      inputSchema: {
        selector: z.string().describe("A CSS selector, e.g. 'button[type=submit]'.")
      }
    },
    async ({ selector }) => {
      try {
        await port.click(selector)
        return ok(`Clicked ${selector}.`)
      } catch (cause) {
        return failed(cause)
      }
    }
  )

  server.registerTool(
    "type",
    {
      description:
        "Type text into the first element matching a CSS selector (works on React-controlled inputs).",
      inputSchema: {
        selector: z.string().describe("A CSS selector for an input or textarea."),
        text: z.string().describe("The text to type.")
      }
    },
    async ({ selector, text }) => {
      try {
        await port.type(selector, text)
        return ok(`Typed into ${selector}.`)
      } catch (cause) {
        return failed(cause)
      }
    }
  )

  server.registerTool(
    "read_text",
    {
      description: "Read the visible text of the in-app browser's current page."
    },
    async () => {
      try {
        const { text } = await port.readText()
        return ok(text)
      } catch (cause) {
        return failed(cause)
      }
    }
  )

  server.registerTool(
    "evaluate",
    {
      description:
        "Evaluate a JavaScript expression in the in-app browser's page and return the result as a string.",
      inputSchema: {
        expression: z.string().describe("A JS expression, e.g. 'document.title'.")
      }
    },
    async ({ expression }) => {
      try {
        const { result } = await port.evaluate(expression)
        return ok(result)
      } catch (cause) {
        return failed(cause)
      }
    }
  )

  server.registerTool(
    "wait_for_selector",
    {
      description: "Wait until a CSS selector appears in the in-app browser's page, or time out.",
      inputSchema: {
        selector: z.string().describe("A CSS selector to wait for."),
        timeoutMs: z
          .number()
          .optional()
          .describe("Max wait in ms (default 10000, capped at 30000).")
      }
    },
    async ({ selector, timeoutMs }) => {
      try {
        await port.waitForSelector(selector, timeoutMs ?? 10_000)
        return ok(`Found ${selector}.`)
      } catch (cause) {
        return failed(cause)
      }
    }
  )

  return server
}
