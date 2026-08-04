import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import {
  makeMemoryMcpProxy,
  MEMORY_MCP_PROXY_AUTH_ENVIRONMENT,
  type MemoryMcpForwardRequest
} from "./memory-mcp-proxy.js"

const loopbackDescribe =
  process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? describe.skip : describe
const LOOPBACK_ATTACHMENT_PATTERN = /^http:\/\/127\.0\.0\.1:\d+\/mcp\//
const LOCAL_BEARER_PATTERN = /^Bearer [A-Za-z0-9_-]+$/

loopbackDescribe("MemoryMcpProxy", () => {
  it("keeps the upstream grant in the main process and forwards stateless MCP", async () => {
    const forwarded: MemoryMcpForwardRequest[] = []
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const proxy = yield* makeMemoryMcpProxy()
          const attachment = yield* proxy.register("org-a:token-a", async (request) => {
            forwarded.push(request)
            return {
              status: 200,
              contentType: "application/json",
              body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } })
            }
          })

          expect(attachment.url).toMatch(LOOPBACK_ATTACHMENT_PATTERN)
          expect(attachment.headers.Authorization).toMatch(LOCAL_BEARER_PATTERN)
          expect(attachment.headerEnvironment).toStrictEqual({
            Authorization: MEMORY_MCP_PROXY_AUTH_ENVIRONMENT
          })

          const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
          const response = yield* Effect.promise(() =>
            fetch(attachment.url, {
              method: "POST",
              headers: {
                ...attachment.headers,
                "content-type": "application/json",
                "mcp-protocol-version": "2026-07-28"
              },
              body
            })
          )
          expect(response.status).toBe(200)
          expect(yield* Effect.promise(() => response.json())).toMatchObject({
            id: 1,
            result: { tools: [] }
          })
          expect(forwarded).toStrictEqual([
            { body, protocolVersion: "2026-07-28" }
          ])

          const unauthorized = yield* Effect.promise(() =>
            fetch(attachment.url, {
              method: "POST",
              headers: { Authorization: "Bearer wrong" },
              body
            })
          )
          expect(unauthorized.status).toBe(401)
        })
      )
    )
  })

})

loopbackDescribe("MemoryMcpProxy registration lifecycle", () => {
  it("reuses a bounded registration while replacing its forwarder", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const proxy = yield* makeMemoryMcpProxy()
          const first = yield* proxy.register("org-a:token-a", async () => ({
            status: 200,
            contentType: "application/json",
            body: "first"
          }))
          const second = yield* proxy.register("org-a:token-a", async () => ({
            status: 200,
            contentType: "text/plain",
            body: "second"
          }))
          expect(second).toStrictEqual(first)

          const response = yield* Effect.promise(() =>
            fetch(second.url, {
              method: "POST",
              headers: second.headers,
              body: "{}"
            })
          )
          expect(yield* Effect.promise(() => response.text())).toBe("second")
        })
      )
    )
  })

  it("preserves live attachments when the registration limit is reached", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const proxy = yield* makeMemoryMcpProxy()
          const attachments = yield* Effect.forEach(
            Array.from({ length: 32 }, (_, index) => index),
            (index) =>
              proxy.register(`registration-${index}`, async () => ({
                status: 200,
                contentType: "text/plain",
                body: `registration-${index}`
              }))
          )

          const overflow = yield* proxy.register("registration-32", async () => ({
            status: 200,
            contentType: "text/plain",
            body: "overflow"
          })).pipe(Effect.either)
          expect(overflow._tag).toBe("Left")

          const first = attachments[0]!
          const response = yield* Effect.promise(() =>
            fetch(first.url, {
              method: "POST",
              headers: first.headers,
              body: "{}"
            })
          )
          expect(response.status).toBe(200)
          expect(yield* Effect.promise(() => response.text())).toBe("registration-0")
        })
      )
    )
  })

  it("returns a JSON 413 without resetting an oversized request", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const proxy = yield* makeMemoryMcpProxy()
          const attachment = yield* proxy.register("large-request", async () => ({
            status: 200,
            contentType: "text/plain",
            body: "unexpected"
          }))
          const response = yield* Effect.promise(() =>
            fetch(attachment.url, {
              method: "POST",
              headers: attachment.headers,
              body: "x".repeat(1024 * 1024 + 1)
            })
          )
          expect(response.status).toBe(413)
          expect(yield* Effect.promise(() => response.json())).toMatchObject({
            error: { message: "Private memory service request failed" }
          })
        })
      )
    )
  })
})
