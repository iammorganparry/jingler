import { randomBytes, timingSafeEqual } from "node:crypto"
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http"
import type { AddressInfo } from "node:net"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { Context, Data, Effect, Layer, type Scope } from "effect"
import { BROWSER_MCP_NAME, buildBrowserControlMcp } from "./browser-control-mcp.js"
import { BrowserControlPort, type BrowserControlPortShape } from "./browser-control-port.js"

const LOOPBACK_HOST = "127.0.0.1"
const MCP_PATH = "/mcp"
const AUTH_HEADER = "Authorization"

export interface BrowserControlMcpRequestMetadata {
  readonly host: string | undefined
  readonly authorization: string | undefined
  readonly path: string
  readonly method: string | undefined
}

export interface BrowserControlMcpRequestRejection {
  readonly status: number
  readonly code: number
  readonly message: string
  readonly headers?: Readonly<Record<string, string>>
}

const jsonError = (
  response: ServerResponse,
  error: BrowserControlMcpRequestRejection
): void => {
  response.writeHead(error.status, {
    "Content-Type": "application/json",
    ...error.headers
  })
  response.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: error.code, message: error.message },
      id: null
    })
  )
}

const sameSecret = (actual: string | undefined, expected: string): boolean => {
  if (actual === undefined) return false
  const actualBytes = Buffer.from(actual)
  const expectedBytes = Buffer.from(expected)
  return (
    actualBytes.byteLength === expectedBytes.byteLength &&
    timingSafeEqual(actualBytes, expectedBytes)
  )
}

const pathOf = (request: IncomingMessage): string =>
  request.url === undefined ? "" : request.url.split("?", 1)[0] ?? ""

/** Pure request-boundary policy, exported so security behavior is testable without a socket. */
export const browserControlMcpRequestRejection = (
  request: BrowserControlMcpRequestMetadata,
  expectedHost: string,
  expectedAuthorization: string
): BrowserControlMcpRequestRejection | null => {
  if (request.host !== expectedHost) {
    return {
      status: 403,
      code: -32_000,
      message: "Forbidden: invalid Host header."
    }
  }

  if (!sameSecret(request.authorization, expectedAuthorization)) {
    return {
      status: 401,
      code: -32_001,
      message: "Unauthorized.",
      headers: { "WWW-Authenticate": "Bearer" }
    }
  }

  if (request.path !== MCP_PATH) {
    return { status: 404, code: -32_000, message: "Not found." }
  }

  if (request.method !== "POST") {
    return {
      status: 405,
      code: -32_000,
      message: "Method not allowed.",
      headers: { Allow: "POST" }
    }
  }

  return null
}

interface HandleMcpRequestOptions {
  readonly browser: BrowserControlPortShape
  readonly expectedHost: string
  readonly authorization: string
  readonly request: IncomingMessage
  readonly response: ServerResponse
}

const handleMcpRequest = async ({
  browser,
  expectedHost,
  authorization,
  request,
  response
}: HandleMcpRequestOptions): Promise<void> => {
  const rejection = browserControlMcpRequestRejection(
    {
      host: request.headers.host,
      authorization: request.headers.authorization,
      path: pathOf(request),
      method: request.method
    },
    expectedHost,
    authorization
  )
  if (rejection !== null) {
    jsonError(response, rejection)
    return
  }

  const mcp = buildBrowserControlMcp(browser)
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  })

  try {
    await mcp.connect(transport)
    await transport.handleRequest(request, response)
  } finally {
    await mcp.close().catch(() => {})
  }
}

const closeListener = (server: Server): Effect.Effect<void> =>
  Effect.async<void>((resume) => {
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      resume(Effect.void)
    }

    try {
      if (!server.listening) {
        finish()
        return
      }
      server.close(finish)
      server.closeAllConnections()
    } catch {
      finish()
    }
  })

export class BrowserControlMcpStartupError extends Data.TaggedError(
  "BrowserControlMcpStartupError"
)<{
  readonly message: string
  readonly cause: unknown
}> {}

const listen = (
  server: Server,
  port: number
): Effect.Effect<Server, BrowserControlMcpStartupError> =>
  Effect.async<Server, BrowserControlMcpStartupError>((resume) => {
    let settled = false
    const cleanup = (): void => {
      server.off("error", onError)
      server.off("listening", onListening)
    }
    const onError = (cause: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      resume(
        Effect.fail(
          new BrowserControlMcpStartupError({
            message: `Browser MCP listener failed to start: ${cause.message}`,
            cause
          })
        )
      )
    }
    const onListening = (): void => {
      if (settled) return
      settled = true
      cleanup()
      resume(Effect.succeed(server))
    }

    server.once("error", onError)
    server.once("listening", onListening)
    try {
      server.listen({ host: LOOPBACK_HOST, port })
    } catch (cause) {
      onError(cause instanceof Error ? cause : new Error(String(cause)))
    }

    return Effect.sync(() => {
      cleanup()
      try {
        server.close()
      } catch {
        // Interruption can race the failed-listen path.
      }
    })
  })

const addressInfo = (server: Server): Effect.Effect<AddressInfo, BrowserControlMcpStartupError> =>
  Effect.try({
    try: () => {
      const address = server.address()
      if (address === null || typeof address === "string") {
        throw new Error("Browser MCP listener has no TCP address")
      }
      return address
    },
    catch: (cause) =>
      new BrowserControlMcpStartupError({
        message: "Browser MCP listener has no TCP address.",
        cause
      })
  })

/**
 * Main-process-only MCP attachment. `headers` contains the bearer credential and
 * must never cross RPC or be persisted; harness adapters consume it only while
 * constructing their child-process launch configuration.
 */
export interface BrowserControlMcpAttachment {
  readonly name: typeof BROWSER_MCP_NAME
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
}

export interface BrowserControlMcpServiceShape {
  /**
   * Null when loopback binding failed. Ordinary sessions continue without the
   * internal browser MCP attachment.
   */
  readonly attachment: BrowserControlMcpAttachment | null
}

export class BrowserControlMcpService extends Context.Tag("@jingler/BrowserControlMcpService")<
  BrowserControlMcpService,
  BrowserControlMcpServiceShape
>() {}

export interface BrowserControlMcpServiceOptions {
  /** Production uses `0` (ephemeral); a fixed port is a test seam for bind failures. */
  readonly port?: number
  /** In-process test seam; production always uses the scoped Node listener below. */
  readonly acquireListener?: BrowserControlMcpListenerAcquirer
}

export type BrowserControlMcpListenerAcquirer = (
  browser: BrowserControlPortShape,
  authorization: string,
  port: number
) => Effect.Effect<number, BrowserControlMcpStartupError, Scope.Scope>

const acquireNodeListener: BrowserControlMcpListenerAcquirer = (
  browser,
  authorization,
  port
) =>
  Effect.gen(function* () {
    let expectedHost = ""
    const server = yield* Effect.try({
      try: () =>
        createServer((request, response) => {
          handleMcpRequest({
            browser,
            expectedHost,
            authorization,
            request,
            response
          }).catch((cause) => {
            if (!response.headersSent) {
              jsonError(response, {
                status: 500,
                code: -32_603,
                message: "Internal server error."
              })
            } else if (cause instanceof Error) {
              response.destroy(cause)
            } else {
              response.destroy()
            }
          })
        }),
      catch: (cause) =>
        new BrowserControlMcpStartupError({
          message: "Browser MCP listener could not be created.",
          cause
        })
    })

    const listener = yield* Effect.acquireRelease(listen(server, port), closeListener)
    const address = yield* addressInfo(listener)
    expectedHost = `${LOOPBACK_HOST}:${address.port}`
    return address.port
  })

const acquireAttachment = (
  browser: BrowserControlPortShape,
  options: BrowserControlMcpServiceOptions
): Effect.Effect<
  BrowserControlMcpAttachment,
  BrowserControlMcpStartupError,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const token = yield* Effect.try({
      try: () => randomBytes(32).toString("base64url"),
      catch: (cause) =>
        new BrowserControlMcpStartupError({
          message: "Browser MCP bearer generation failed.",
          cause
        })
    })
    const authorization = `Bearer ${token}`
    const listenerPort = yield* (options.acquireListener ?? acquireNodeListener)(
      browser,
      authorization,
      options.port ?? 0
    )
    const expectedHost = `${LOOPBACK_HOST}:${listenerPort}`

    return {
      name: BROWSER_MCP_NAME,
      url: `http://${expectedHost}${MCP_PATH}`,
      headers: { [AUTH_HEADER]: authorization }
    }
  })

export const makeBrowserControlMcpServiceLayer = (
  options: BrowserControlMcpServiceOptions = {}
) =>
  Layer.scoped(
    BrowserControlMcpService,
    Effect.gen(function* () {
      const browser = yield* BrowserControlPort
      const attachment = yield* acquireAttachment(browser, options).pipe(
        Effect.catchAll((error) =>
          Effect.logWarning(error.message).pipe(Effect.as<BrowserControlMcpAttachment | null>(null))
        )
      )
      return BrowserControlMcpService.of({ attachment })
    })
  )

export const BrowserControlMcpServiceLive = makeBrowserControlMcpServiceLayer()
