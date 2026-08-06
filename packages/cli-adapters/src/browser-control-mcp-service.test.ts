import { createServer, request as httpRequest, type Server } from "node:http"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { Effect, Layer, type Scope } from "effect"
import { describe, expect, it } from "vitest"
import {
  browserControlMcpRequestRejection,
  BrowserControlMcpService,
  BrowserControlMcpStartupError,
  makeBrowserControlMcpServiceLayer,
  type BrowserControlMcpAttachment,
  type BrowserControlMcpListenerAcquirer,
  type BrowserControlMcpServerFactory,
  type BrowserControlMcpServiceOptions,
  type BrowserControlMcpServiceShape
} from "./browser-control-mcp-service.js"
import {
  BrowserControlPort,
  type BrowserControlPortShape,
  type BrowserControlSessionPortShape
} from "./browser-control-port.js"

const loopbackDescribe =
  process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? describe.skip : describe
const loopbackIt = process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? it.skip : it
const BEARER_PREFIX = /^Bearer /
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

const stubSessionPort = (
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

const stubPort = (
  over: Partial<BrowserControlSessionPortShape> = {}
): BrowserControlPortShape => ({
  forSession: () => stubSessionPort(over)
})

const runWithServiceEffect = <A>(
  browser: BrowserControlPortShape,
  use: (
    service: BrowserControlMcpServiceShape
  ) => Effect.Effect<A, never, Scope.Scope>,
  options: BrowserControlMcpServiceOptions = {}
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* BrowserControlMcpService
        return yield* use(service)
      }).pipe(
        Effect.provide(
          makeBrowserControlMcpServiceLayer(options).pipe(
            Layer.provide(Layer.succeed(BrowserControlPort, browser))
          )
        )
      )
    )
  )

const runWithLease = <A>(
  browser: BrowserControlPortShape,
  use: (attachment: BrowserControlMcpAttachment | null) => Promise<A>,
  options: BrowserControlMcpServiceOptions = {}
): Promise<A> =>
  runWithServiceEffect(
    browser,
    (service) =>
      Effect.gen(function* () {
        const attachment = yield* service.acquire("session-a", "test-run")
        return yield* Effect.promise(() => use(attachment))
      }),
    options
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

    await runWithLease(
      stubPort({
        navigate: async (url) => {
          navigated.push(url)
        }
      }),
      async (attachment) => {
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
    await runWithLease(stubPort(), async (attachment) => {
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

  it("closes an old session listener when its run scope ends and mints a replacement", async () => {
    await runWithServiceEffect(stubPort(), (service) =>
      Effect.gen(function* () {
        const first = yield* Effect.scoped(service.acquire("session-a", "first"))
        expect(first).not.toBeNull()
        if (first === null) throw new Error("Browser MCP listener was unavailable")

        const oldListenerClosed = yield* Effect.promise(() =>
          requestJson(first.url, "POST", first.headers, "{}").then(
            () => false,
            () => true
          )
        )
        expect(oldListenerClosed).toBe(true)

        const second = yield* service.acquire("session-a", "second")
        expect(second).not.toBeNull()
        if (second === null) throw new Error("Replacement browser lease was unavailable")
        expect(second.headers.Authorization).not.toBe(first.headers.Authorization)

        const accepted = yield* Effect.promise(() =>
          requestJson(second.url, "GET", second.headers)
        )
        expect(accepted.status).toBe(405)
      })
    )
  })
})

loopbackDescribe("BrowserControlMcpService loopback disposal", () => {
  it("closes the loopback listener when its Effect scope is disposed", async () => {
    let releasedPort = 0
    await runWithLease(stubPort(), async (attachment) => {
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
      browserControlMcpRequestRejection(valid, expectedHost, null)
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
  it("generates a per-run bearer and releases its listener with the Effect scope", async () => {
    let released = false
    const acquireListener: BrowserControlMcpListenerAcquirer = () =>
      Effect.acquireRelease(
        Effect.succeed({
          port: 43_210,
          isAvailable: () => true
        }),
        () =>
          Effect.sync(() => {
            released = true
          })
      )

    const attachment = await runWithLease(
      stubPort(),
      async (lease) => lease,
      { acquireListener }
    )

    expect(attachment).not.toBeNull()
    if (attachment === null) throw new Error("Browser MCP listener was unavailable")
    const secret = attachment.headers.Authorization?.replace(BEARER_PREFIX, "")
    expect(secret).toMatch(TOKEN_PATTERN)
    expect(attachment.url).toBe("http://127.0.0.1:43210/mcp")
    expect(attachment.url).not.toContain(secret)
    expect(attachment.headerEnvironment).toStrictEqual({
      Authorization: "JINGLER_BROWSER_MCP_AUTHORIZATION"
    })
    expect(released).toBe(true)
  })

  it("grants one exclusive lease and rejects a concurrent owner", async () => {
    const acquireListener: BrowserControlMcpListenerAcquirer = () =>
      Effect.succeed({
        port: 43_210,
        isAvailable: () => true
      })

    const leases = await runWithServiceEffect(
      stubPort(),
      (service) =>
        Effect.gen(function* () {
          const first = yield* service.acquire("session-a", "first")
          const second = yield* service.acquire("session-a", "second")
          return { first, second }
        }),
      { acquireListener }
    )

    expect(leases.first).not.toBeNull()
    expect(leases.second).toBeNull()
  })

  it("grants concurrent leases to different sessions and binds each listener port", async () => {
    const boundSessions: string[] = []
    const browser: BrowserControlPortShape = {
      forSession: (sessionId) => {
        boundSessions.push(sessionId)
        return stubSessionPort()
      }
    }
    let nextPort = 43_210
    const acquireListener: BrowserControlMcpListenerAcquirer = () =>
      Effect.succeed({
        port: nextPort++,
        isAvailable: () => true
      })

    const leases = await runWithServiceEffect(
      browser,
      (service) =>
        Effect.gen(function* () {
          const alpha = yield* service.acquire("alpha", "alpha-run")
          const beta = yield* service.acquire("beta", "beta-run")
          return { alpha, beta }
        }),
      { acquireListener }
    )

    expect(leases.alpha?.url).toBe("http://127.0.0.1:43210/mcp")
    expect(leases.beta?.url).toBe("http://127.0.0.1:43211/mcp")
    expect(boundSessions).toStrictEqual(["alpha", "beta"])
  })

  it("revokes a deleted session without disturbing another session", async () => {
    const authorizations = new Map<string, () => string | null>()
    let activeSession = ""
    const browser: BrowserControlPortShape = {
      forSession: (sessionId) => {
        activeSession = sessionId
        return stubSessionPort()
      }
    }
    const acquireListener: BrowserControlMcpListenerAcquirer = (_browser, authorization) => {
      authorizations.set(activeSession, authorization)
      return Effect.succeed({ port: 43_210 + authorizations.size, isAvailable: () => true })
    }

    await runWithServiceEffect(
      browser,
      (service) =>
        Effect.gen(function* () {
          yield* service.acquire("alpha", "alpha-run")
          yield* service.acquire("beta", "beta-run")
          expect(authorizations.get("alpha")?.()).toMatch(BEARER_PREFIX)
          expect(authorizations.get("beta")?.()).toMatch(BEARER_PREFIX)
          yield* service.revoke("alpha")
          expect(authorizations.get("alpha")?.()).toBeNull()
          expect(authorizations.get("beta")?.()).toMatch(BEARER_PREFIX)
        }),
      { acquireListener }
    )
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

    const result = await runWithLease(
      stubPort(),
      async (attachment) => ({ attachment, ordinarySession: "usable" }),
      { acquireListener }
    )

    expect(result).toStrictEqual({
      attachment: null,
      ordinarySession: "usable"
    })
  })

  loopbackIt("contains a listener error to its lease so another session can still acquire", async () => {
    let server: Server | null = null
    const serverFactory: BrowserControlMcpServerFactory = (listener) => {
      server = createServer(listener)
      return server
    }

    const result = await runWithServiceEffect(
      stubPort(),
      (service) =>
        Effect.gen(function* () {
          const initial = yield* service.acquire("session-a", "initial")
          expect(initial).not.toBeNull()
          if (server === null) throw new Error("Browser MCP server was not created")

          server.emit("error", new Error("simulated accept failure"))
          const afterError = yield* service.acquire("session-b", "after-error")
          return { afterError }
        }),
      { serverFactory }
    )

    expect(result.afterError).not.toBeNull()
  })
})
