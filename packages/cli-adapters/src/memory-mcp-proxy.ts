import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http"
import type { AddressInfo } from "node:net"
import { Data, Effect } from "effect"
import type { Scope } from "effect"
import type { RemoteMcpServer } from "./adapter.js"

const LOOPBACK_HOST = "127.0.0.1"
const AUTHORIZATION_HEADER = "Authorization"
const MAX_REQUEST_BYTES = 1024 * 1024
const MAX_REGISTRATIONS = 32

export const MEMORY_MCP_PROXY_AUTH_ENVIRONMENT = "JINGLER_MEMORY_AUTHORIZATION"

export interface MemoryMcpForwardRequest {
  readonly body: string
  readonly protocolVersion: string | undefined
}

export interface MemoryMcpForwardResponse {
  readonly status: number
  readonly body: string
  readonly contentType: string | null
}

export type MemoryMcpForwarder = (
  request: MemoryMcpForwardRequest
) => Promise<MemoryMcpForwardResponse>

interface Registration {
  readonly path: string
  readonly authorization: string
  readonly attachment: RemoteMcpServer
  forward: MemoryMcpForwarder
}

export interface MemoryMcpProxy {
  readonly register: (
    key: string,
    forward: MemoryMcpForwarder
  ) => Effect.Effect<RemoteMcpServer, MemoryMcpProxyError>
}

export class MemoryMcpProxyError extends Data.TaggedError("MemoryMcpProxyError")<{
  readonly message: string
  readonly cause: unknown
}> {}

const sameSecret = (actual: string | undefined, expected: string): boolean => {
  if (actual === undefined) return false
  const actualBytes = Buffer.from(actual)
  const expectedBytes = Buffer.from(expected)
  return (
    actualBytes.byteLength === expectedBytes.byteLength &&
    timingSafeEqual(actualBytes, expectedBytes)
  )
}

const jsonError = (response: ServerResponse, status: number, message: string): void => {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json"
  })
  response.end(
    JSON.stringify({ jsonrpc: "2.0", error: { code: -32_000, message }, id: null })
  )
}

const bodyOf = (request: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    let settled = false
    request.on("data", (chunk: Buffer) => {
      if (settled) return
      total += chunk.byteLength
      if (total > MAX_REQUEST_BYTES) {
        settled = true
        reject(new Error("Memory MCP request is too large"))
        return
      }
      chunks.push(chunk)
    })
    request.on("end", () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks).toString("utf8"))
    })
    request.on("error", (cause) => {
      if (settled) return
      settled = true
      reject(cause)
    })
  })

const closeServer = (server: Server): Effect.Effect<void> =>
  Effect.async<void>((resume) => {
    if (!server.listening) {
      resume(Effect.void)
      return
    }
    server.close(() => resume(Effect.void))
    server.closeAllConnections()
  })

const listen = (server: Server): Effect.Effect<AddressInfo, MemoryMcpProxyError> =>
  Effect.async<AddressInfo, MemoryMcpProxyError>((resume) => {
    let settled = false
    const finish = (effect: Effect.Effect<AddressInfo, MemoryMcpProxyError>): void => {
      if (settled) return
      settled = true
      server.off("error", onError)
      server.off("listening", onListening)
      resume(effect)
    }
    const onError = (cause: Error): void =>
      finish(
        Effect.fail(
          new MemoryMcpProxyError({
            message: `Memory MCP proxy failed to start: ${cause.message}`,
            cause
          })
        )
      )
    const onListening = (): void => {
      const address = server.address()
      if (address === null || typeof address === "string") {
        onError(new Error("Memory MCP proxy has no TCP address"))
        return
      }
      finish(Effect.succeed(address))
    }
    server.once("error", onError)
    server.once("listening", onListening)
    server.listen({ host: LOOPBACK_HOST, port: 0 })
    return Effect.sync(() => {
      server.off("error", onError)
      server.off("listening", onListening)
      if (server.listening) server.close()
    })
  })

const registrationAt = (
  registrations: ReadonlyMap<string, Registration>,
  request: IncomingMessage
): Registration | undefined => {
  const path = request.url?.split("?", 1)[0] ?? ""
  return [...registrations.values()].find((candidate) => candidate.path === path)
}

const writeForwardFailure = (response: ServerResponse, cause: unknown): void => {
  if (response.headersSent) {
    response.destroy(cause instanceof Error ? cause : undefined)
    return
  }
  const tooLarge = cause instanceof Error && cause.message.includes("too large")
  jsonError(response, tooLarge ? 413 : 502, "Private memory service request failed")
}

const forwardRegisteredRequest = async (
  registration: Registration,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> => {
  try {
    const upstream = await registration.forward({
      body: await bodyOf(request),
      protocolVersion:
        typeof request.headers["mcp-protocol-version"] === "string"
          ? request.headers["mcp-protocol-version"]
          : undefined
    })
    response.writeHead(upstream.status, {
      "cache-control": "no-store",
      "content-type": upstream.contentType ?? "application/json"
    })
    response.end(upstream.body)
  } catch (cause) {
    writeForwardFailure(response, cause)
  }
}

const handleProxyRequest = async (
  registrations: ReadonlyMap<string, Registration>,
  expectedHost: string,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> => {
  const registration = registrationAt(registrations, request)
  const authenticated =
    request.headers.host === expectedHost &&
    registration !== undefined &&
    sameSecret(request.headers.authorization, registration.authorization)
  if (!authenticated || registration === undefined) {
    jsonError(response, 401, "Unauthorized")
    return
  }
  if (request.method !== "POST") {
    jsonError(response, 405, "Method not allowed")
    return
  }
  await forwardRegisteredRequest(registration, request, response)
}

interface RegistrationRuntime {
  readonly address: AddressInfo
  readonly expectedHost: string
  readonly registrations: Map<string, Registration>
  readonly server: Server
}

const registerWith = (
  runtime: RegistrationRuntime,
  key: string,
  forward: MemoryMcpForwarder
): Effect.Effect<RemoteMcpServer, MemoryMcpProxyError> =>
  Effect.gen(function* () {
    if (runtime.address.port === 0 || !runtime.server.listening) {
      return yield* new MemoryMcpProxyError({
        message: "Memory MCP proxy is unavailable",
        cause: null
      })
    }
    const existing = runtime.registrations.get(key)
    if (existing !== undefined) {
      existing.forward = forward
      return existing.attachment
    }
    // An attachment can remain in a running harness for hours. Evicting a
    // registration here would invalidate that live URL while its caller still
    // believes it is usable, so reject new registrations once the app-lifetime
    // bound is reached and preserve every attachment already handed out.
    if (runtime.registrations.size >= MAX_REGISTRATIONS) {
      return yield* new MemoryMcpProxyError({
        message: "Memory MCP proxy registration limit reached",
        cause: null
      })
    }
    const token = yield* Effect.try({
      try: () => randomBytes(32).toString("base64url"),
      catch: (cause) =>
        new MemoryMcpProxyError({
          message: "Memory MCP proxy bearer generation failed",
          cause
        })
    })
    const authorization = `Bearer ${token}`
    const path = `/mcp/${randomUUID()}`
    const attachment: RemoteMcpServer = {
      name: "jingler-memory",
      url: `http://${runtime.expectedHost}${path}`,
      headers: { [AUTHORIZATION_HEADER]: authorization },
      headerEnvironment: {
        [AUTHORIZATION_HEADER]: MEMORY_MCP_PROXY_AUTH_ENVIRONMENT
      }
    }
    runtime.registrations.set(key, { path, authorization, attachment, forward })
    return attachment
  })

/**
 * App-lifetime, authenticated loopback proxy for the private memory MCP.
 *
 * Harnesses receive only a random local bearer. Every upstream request is
 * forwarded by MemoryService, which can refresh the short-lived organization
 * grant without restarting a long Claude or Codex turn.
 */
export const makeMemoryMcpProxy = (): Effect.Effect<MemoryMcpProxy, never, Scope.Scope> =>
  Effect.gen(function* () {
    const registrations = new Map<string, Registration>()
    let expectedHost = ""
    const server = createServer((request, response) =>
      handleProxyRequest(registrations, expectedHost, request, response)
    )
    const address = yield* listen(server).pipe(
      Effect.catchAll((error) =>
        Effect.logWarning(error.message).pipe(
          Effect.as<AddressInfo>({ address: LOOPBACK_HOST, family: "IPv4", port: 0 })
        )
      )
    )
    if (address.port > 0) {
      expectedHost = `${LOOPBACK_HOST}:${address.port}`
      yield* Effect.addFinalizer(() => closeServer(server))
    }

    const runtime = { address, expectedHost, registrations, server }
    return { register: (key, forward) => registerWith(runtime, key, forward) }
  })
