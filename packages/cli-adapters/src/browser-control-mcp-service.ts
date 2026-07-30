import { randomBytes, timingSafeEqual } from "node:crypto"
import {
  createServer,
  type IncomingMessage,
  type RequestListener,
  type Server,
  type ServerResponse
} from "node:http"
import type { AddressInfo } from "node:net"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { Context, Data, Effect, Layer, Runtime, type Scope } from "effect"
import { BROWSER_MCP_NAME, buildBrowserControlMcp } from "./browser-control-mcp.js"
import { BrowserControlPort, type BrowserControlPortShape } from "./browser-control-port.js"

const LOOPBACK_HOST = "127.0.0.1"
const MCP_PATH = "/mcp"
const AUTH_HEADER = "Authorization"
export const BROWSER_MCP_AUTH_ENV = "JINGLER_BROWSER_MCP_AUTHORIZATION"

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
  expectedAuthorization: string | null
): BrowserControlMcpRequestRejection | null => {
  if (request.host !== expectedHost) {
    return {
      status: 403,
      code: -32_000,
      message: "Forbidden: invalid Host header."
    }
  }

  if (
    expectedAuthorization === null ||
    !sameSecret(request.authorization, expectedAuthorization)
  ) {
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
  readonly authorization: () => string | null
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
    authorization()
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
  /**
   * Header values that Codex should resolve from its process environment instead
   * of exposing in `-c` argv. The process receives the value only for this run.
   */
  readonly headerEnvironment: Readonly<Record<string, string>>
}

export interface BrowserControlMcpServiceShape {
  /**
   * Acquire exclusive browser control for one run. Null means the listener is
   * unavailable or another run currently owns the single native Preview view.
   * The bearer is revoked automatically with the caller's Effect scope.
   */
  readonly acquire: (
    ownerId: string
  ) => Effect.Effect<BrowserControlMcpAttachment | null, never, Scope.Scope>
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
  /** Test seam for emitting a post-listen Server error on the real lifecycle path. */
  readonly serverFactory?: BrowserControlMcpServerFactory
}

export interface BrowserControlMcpListener {
  readonly port: number
  readonly isAvailable: () => boolean
}

export type BrowserControlMcpServerFactory = (listener: RequestListener) => Server

export type BrowserControlMcpListenerAcquirer = (
  browser: BrowserControlPortShape,
  authorization: () => string | null,
  port: number
) => Effect.Effect<BrowserControlMcpListener, BrowserControlMcpStartupError, Scope.Scope>

const nodeServerFactory: BrowserControlMcpServerFactory = (listener) =>
  createServer(listener)

const acquireNodeListener = (
  serverFactory: BrowserControlMcpServerFactory
): BrowserControlMcpListenerAcquirer =>
  (browser, authorization, port) =>
    Effect.gen(function* () {
      let expectedHost = ""
      const server = yield* Effect.try({
        try: () =>
          serverFactory((request, response) => {
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

      const listener = yield* listen(server, port)
      const address = yield* addressInfo(listener)
      expectedHost = `${LOOPBACK_HOST}:${address.port}`

      let available = true
      const runtime = yield* Effect.runtime<never>()
      const onLifetimeError = (cause: Error): void => {
        available = false
        Runtime.runFork(runtime)(
          Effect.logError(`Browser MCP listener stopped after startup: ${cause.message}`)
        )
        try {
          listener.close()
          listener.closeAllConnections()
        } catch {
          // The error may already have closed the listener.
        }
      }
      listener.on("error", onLifetimeError)
      yield* Effect.addFinalizer(() =>
        closeListener(listener).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              listener.off("error", onLifetimeError)
            })
          )
        )
      )

      return {
        port: address.port,
        isAvailable: () => available && listener.listening
      }
    })

const createAttachment = (
  listenerPort: number
): Effect.Effect<BrowserControlMcpAttachment, BrowserControlMcpStartupError> =>
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
    const expectedHost = `${LOOPBACK_HOST}:${listenerPort}`

    return {
      name: BROWSER_MCP_NAME,
      url: `http://${expectedHost}${MCP_PATH}`,
      headers: { [AUTH_HEADER]: authorization },
      headerEnvironment: { [AUTH_HEADER]: BROWSER_MCP_AUTH_ENV }
    }
  })

export const makeBrowserControlMcpServiceLayer = (
  options: BrowserControlMcpServiceOptions = {}
) =>
  Layer.scoped(
    BrowserControlMcpService,
    Effect.gen(function* () {
      const browser = yield* BrowserControlPort
      let activeAttachment: BrowserControlMcpAttachment | null = null
      const listener = yield* (
        options.acquireListener ??
        acquireNodeListener(options.serverFactory ?? nodeServerFactory)
      )(
        browser,
        () => activeAttachment?.headers[AUTH_HEADER] ?? null,
        options.port ?? 0
      ).pipe(
        Effect.catchAll((error) =>
          Effect.logWarning(error.message).pipe(
            Effect.as<BrowserControlMcpListener | null>(null)
          )
        )
      )

      const acquire = (
        ownerId: string
      ): Effect.Effect<BrowserControlMcpAttachment | null, never, Scope.Scope> =>
        Effect.acquireRelease(
          Effect.gen(function* () {
            if (
              listener === null ||
              !listener.isAvailable() ||
              activeAttachment !== null
            ) {
              return null
            }
            const attachment = yield* createAttachment(listener.port)
            activeAttachment = attachment
            return attachment
          }).pipe(
            Effect.catchAll((error) =>
              Effect.logWarning(
                `Browser MCP lease for ${ownerId} could not be created: ${error.message}`
              ).pipe(Effect.as<BrowserControlMcpAttachment | null>(null))
            )
          ),
          (attachment) =>
            Effect.sync(() => {
              if (attachment !== null && activeAttachment === attachment) {
                activeAttachment = null
              }
            })
        )

      return BrowserControlMcpService.of({ acquire })
    })
  )

export const BrowserControlMcpServiceLive = makeBrowserControlMcpServiceLayer()
