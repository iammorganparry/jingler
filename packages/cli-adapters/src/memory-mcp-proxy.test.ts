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
})
