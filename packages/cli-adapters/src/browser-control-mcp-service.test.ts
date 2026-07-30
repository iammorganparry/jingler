import { createServer, request as httpRequest, type Server } from "node:http"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import {
  browserControlMcpRequestRejection,
  BrowserControlMcpService,
  BrowserControlMcpStartupError,
  makeBrowserControlMcpServiceLayer,
  type BrowserControlMcpListenerAcquirer,
  type BrowserControlMcpServiceOptions,
  type BrowserControlMcpServiceShape
} from "./browser-control-mcp-service.js"
import { BrowserControlPort, type BrowserControlPortShape } from "./browser-control-port.js"

const loopbackDescribe =
  process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? describe.skip : describe
const BEARER_PREFIX = /^Bearer /
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

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

const runWithService = <A>(
  browser: BrowserControlPortShape,
  use: (service: BrowserControlMcpServiceShape) => Promise<A>,
  options: BrowserControlMcpServiceOptions = {}
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* BrowserControlMcpService
        return yield* Effect.promise(() => use(service))
      }).pipe(
        Effect.provide(
          makeBrowserControlMcpServiceLayer(options).pipe(
            Layer.provide(Layer.succeed(BrowserControlPort, browser))
          )
        )
      )
    )
  )

const startListener = async (port = 0): Promise<{ readonly server: Server; readonly port: number }> => {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen({ host: "127.0.0.1", port }, resolve)
  })
  const address = server.address()
  if (address === null || typeof address === "string") {
    server.close()
    throw new Error("Test listener has no TCP address")
  }
  return { server, port: address.port }
}

const closeListener = async (server: Server): Promise<void> => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve())
  })
}

const requestJson = (
  url: string,
  method: string,
  headers: Readonly<Record<string, string>> = {},
  body?: string
): Promise<{ readonly status: number; readonly body: unknown }> =>
  new Promise((resolve, reject) => {
    const request = httpRequest(url, { method, headers }, (response) => {
      let raw = ""
      response.setEncoding("utf8")
      response.on("data", (chunk) => {
        raw += chunk
      })
      response.on("end", () => {
        try {
          resolve({
            status: response.statusCode ?? 0,
            body: JSON.parse(raw)
          })
        } catch (cause) {
          reject(cause)
        }
      })
    })
    request.on("error", reject)
    if (body !== undefined) request.write(body)
    request.end()
  })

loopbackDescribe("BrowserControlMcpService authenticated loopback", () => {
  it("serves the native browser MCP to an authenticated standard client", async () => {
    const navigated: Array<string> = []

    await runWithService(
      stubPort({
        navigate: async (url) => {
          navigated.push(url)
        }
      }),
      async ({ attachment }) => {
        expect(attachment).not.toBeNull()
        if (attachment === null) throw new Error("Browser MCP listener was unavailable")

        const transport = new StreamableHTTPClientTransport(new URL(attachment.url), {
          requestInit: { headers: { ...attachment.headers } }
        })
        const client = new Client({ name: "browser-mcp-test", version: "1.0.0" })
        try {
          await client.connect(transport)
          const tools = await client.listTools()
          expect(tools.tools.map((tool) => tool.name).sort()).toStrictEqual([
            "click",
            "evaluate",
            "navigate",
            "read_text",
            "screenshot",
            "type",
            "wait_for_selector"
          ])

          const result = await client.callTool({
            name: "navigate",
            arguments: { url: "http://127.0.0.1:5173" }
          })
          expect(result.isError).toBeFalsy()
          expect(navigated).toStrictEqual(["http://127.0.0.1:5173"])
        } finally {
          await client.close()
        }
      }
    )
  })
})

loopbackDescribe("BrowserControlMcpService loopback security", () => {
  it("rejects missing, incorrect, and invalid-host credentials with JSON errors", async () => {
    await runWithService(stubPort(), async ({ attachment }) => {
      expect(attachment).not.toBeNull()
      if (attachment === null) throw new Error("Browser MCP listener was unavailable")

      const missing = await requestJson(attachment.url, "POST", {}, "{}")
      const incorrect = await requestJson(
        attachment.url,
        "POST",
        { Authorization: "Bearer wrong" },
        "{}"
      )
      const invalidHost = await requestJson(
        attachment.url,
        "POST",
        { ...attachment.headers, Host: "attacker.example" },
        "{}"
      )
      const unsupportedMethod = await requestJson(
        attachment.url,
        "GET",
        attachment.headers
      )

      expect(missing.status).toBe(401)
      expect(incorrect.status).toBe(401)
      expect(invalidHost.status).toBe(403)
      expect(unsupportedMethod.status).toBe(405)
      expect(missing.body).toMatchObject({
        jsonrpc: "2.0",
        error: { code: -32_001, message: "Unauthorized." },
        id: null
      })
      expect(invalidHost.body).toMatchObject({
        jsonrpc: "2.0",
        error: { code: -32_000, message: "Forbidden: invalid Host header." },
        id: null
      })
      expect(unsupportedMethod.body).toMatchObject({
        jsonrpc: "2.0",
        error: { code: -32_000, message: "Method not allowed." },
        id: null
      })

      const secret = attachment.headers.Authorization?.replace(BEARER_PREFIX, "")
      expect(secret).toMatch(TOKEN_PATTERN)
      expect(attachment.url).not.toContain(secret)
    })
  })
})

loopbackDescribe("BrowserControlMcpService loopback disposal", () => {
  it("closes the loopback listener when its Effect scope is disposed", async () => {
    let releasedPort = 0
    await runWithService(stubPort(), async ({ attachment }) => {
      expect(attachment).not.toBeNull()
      if (attachment === null) throw new Error("Browser MCP listener was unavailable")
      releasedPort = Number(new URL(attachment.url).port)
    })

    const rebound = await startListener(releasedPort)
    await closeListener(rebound.server)
    expect(rebound.port).toBe(releasedPort)
  })
})

describe("BrowserControlMcpService request policy", () => {
  it("rejects unauthorized, invalid-host, path, and method requests deterministically", () => {
    const expectedHost = "127.0.0.1:43210"
    const expectedAuthorization = "Bearer correct"
    const valid = {
      host: expectedHost,
      authorization: expectedAuthorization,
      path: "/mcp",
      method: "POST"
    }

    expect(
      browserControlMcpRequestRejection(
        { ...valid, authorization: undefined },
        expectedHost,
        expectedAuthorization
      )
    ).toMatchObject({ status: 401, code: -32_001, message: "Unauthorized." })
    expect(
      browserControlMcpRequestRejection(
        { ...valid, authorization: "Bearer wrong" },
        expectedHost,
        expectedAuthorization
      )
    ).toMatchObject({ status: 401, code: -32_001, message: "Unauthorized." })
    expect(
      browserControlMcpRequestRejection(
        { ...valid, host: "attacker.example" },
        expectedHost,
        expectedAuthorization
      )
    ).toMatchObject({
      status: 403,
      code: -32_000,
      message: "Forbidden: invalid Host header."
    })
    expect(
      browserControlMcpRequestRejection(
        { ...valid, path: "/other" },
        expectedHost,
        expectedAuthorization
      )
    ).toMatchObject({ status: 404, code: -32_000, message: "Not found." })
    expect(
      browserControlMcpRequestRejection(
        { ...valid, method: "GET" },
        expectedHost,
        expectedAuthorization
      )
    ).toStrictEqual({
      status: 405,
      code: -32_000,
      message: "Method not allowed.",
      headers: { Allow: "POST" }
    })
    expect(
      browserControlMcpRequestRejection(valid, expectedHost, expectedAuthorization)
    ).toBeNull()
  })
})

describe("BrowserControlMcpService scoped attachment", () => {
  it("generates a main-only bearer and releases its listener with the Effect scope", async () => {
    let released = false
    const acquireListener: BrowserControlMcpListenerAcquirer = () =>
      Effect.acquireRelease(
        Effect.succeed(43_210),
        () =>
          Effect.sync(() => {
            released = true
          })
      )

    const attachment = await runWithService(
      stubPort(),
      async (service) => service.attachment,
      { acquireListener }
    )

    expect(attachment).not.toBeNull()
    if (attachment === null) throw new Error("Browser MCP listener was unavailable")
    const secret = attachment.headers.Authorization?.replace(BEARER_PREFIX, "")
    expect(secret).toMatch(TOKEN_PATTERN)
    expect(attachment.url).toBe("http://127.0.0.1:43210/mcp")
    expect(attachment.url).not.toContain(secret)
    expect(released).toBe(true)
  })
})

describe("BrowserControlMcpService startup degradation", () => {
  it("degrades listener startup failure to a null attachment", async () => {
    const acquireListener: BrowserControlMcpListenerAcquirer = () =>
      Effect.fail(
        new BrowserControlMcpStartupError({
          message: "Browser MCP listener failed to start: EADDRINUSE",
          cause: new Error("EADDRINUSE")
        })
      )

    const result = await runWithService(
      stubPort(),
      async ({ attachment }) => ({ attachment, ordinarySession: "usable" }),
      { acquireListener }
    )

    expect(result).toStrictEqual({
      attachment: null,
      ordinarySession: "usable"
    })
  })
})
