import { IncomingMessage, type Server, type ServerResponse } from "node:http"
import { Socket } from "node:net"
import { afterEach, describe, expect, it, vi } from "vitest"
import { startFakeAuthServer } from "../../../e2e/fake-auth.js"
import { startFakeGitHubServer } from "../../../e2e/fake-github.js"

// Exercise the real handlers and stream parsing without binding a TCP port.
const servers = vi.hoisted(() => new Map<number, Server>())
vi.mock("node:http", async (importOriginal) => {
  const http = await importOriginal<typeof import("node:http")>()
  return {
    ...http,
    createServer: (listener: import("node:http").RequestListener) => {
      const server = http.createServer(listener)
      const port = servers.size + 10_000
      servers.set(port, server)
      server.listen = ((_port: number, _host: string, ready: () => void) => {
        ready()
        return server
      }) as typeof server.listen
      server.address = () => ({ address: "127.0.0.1", family: "IPv4", port })
      server.close = (closed) => {
        servers.delete(port)
        closed?.()
        return server
      }
      return server
    }
  }
})

const fixtureFetch = (input: string, options: RequestInit = {}): Promise<Response> =>
  new Promise((resolve, reject) => {
    const url = new URL(input)
    const server = servers.get(Number(url.port))!
    const incoming = new IncomingMessage(new Socket())
    incoming.url = `${url.pathname}${url.search}`
    incoming.method = options.method ?? "GET"
    incoming.headers = Object.fromEntries(new Headers(options.headers))
    let status = 200
    let headers: Record<string, string> = {}
    const response = {
      writeHead(code: number, values: Record<string, string> = {}) {
        status = code
        headers = values
        return response
      },
      end(body = "") {
        resolve(new Response(status === 204 ? null : body, { status, headers }))
        return response
      }
    }
    incoming.push(options.body === undefined ? null : Buffer.from(String(options.body)))
    if (options.body !== undefined) incoming.push(null)
    const handler = server.listeners("request")[0]!
    Promise.resolve(handler(incoming, response as unknown as ServerResponse)).catch(reject)
  })

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((close) => close()))
})

const request = (url: string, path: string, token: string, body?: unknown, method = "POST") =>
  fixtureFetch(`${url}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })

describe("fixture HTTP dispatch", () => {
  it("preserves MCP admission, alternating instances, and tool result bodies", async () => {
    const server = await startFakeAuthServer()
    cleanups.push(server.close)
    const grantResponse = await request(server.url, "/api/memory/grant", server.token, { organizationId: "org-e2e" })
    const { grant } = await grantResponse.json()
    const call = (name: string, args: unknown = {}) => fixtureFetch(`${server.url}/api/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${grant}`,
        "content-type": "application/json",
        "x-jingler-organization-id": "org-e2e",
        "mcp-protocol-version": "2026-07-28"
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: "request-1", method: "tools/call", params: { name, arguments: args } })
    })
    const search = await call("memory_search", { query: "alpha" })
    expect(search.status).toBe(200)
    expect(search.headers.get("x-fake-next-instance")).toBe("next-a")
    expect((await search.json()).result.structuredContent.data).toMatchObject({ query: "alpha", results: expect.any(Array) })
    const evidence = await call("memory_edge_evidence")
    expect(evidence.headers.get("x-fake-next-instance")).toBe("next-b")
    expect((await evidence.json()).result.structuredContent.data).toHaveProperty("evidence.pageId", "alpha")
    expect((await call("memory_read", { pageId: "missing" })).status).toBe(200)
    for (const name of ["memory_dashboard", "memory_suggestions", "memory_graph", "memory_graph_neighborhood", "memory_reviews", "memory_navigation", "memory_export", "memory_propose", "memory_workflow_status", "memory_review", "unknown_tool"]) {
      const result = await call(name)
      expect((await result.json()).result.structuredContent.data).toBeTypeOf("object")
    }
    expect((await request(server.url, "/api/mcp", "invalid", {})).status).toBe(401)
    expect((await fixtureFetch(`${server.url}/api/mcp`)).status).toBe(405)
    expect((await fixtureFetch(`${server.url}/missing`)).status).toBe(404)
  })

  it.each(["success", "failed"] as const)("keeps the offload preparing-to-%s sequence", async (offloadResult) => {
    const server = await startFakeAuthServer({ offloadResult })
    cleanups.push(server.close)
    const path = "/v1/offload/jobs/job-test/events"
    const initial = await fixtureFetch(`${server.url}${path}`)
    expect(await initial.json()).toMatchObject({ state: "preparing", cursor: 1, result: null })
    const settled = await fixtureFetch(`${server.url}${path}`)
    expect(await settled.json()).toMatchObject({
      state: offloadResult === "failed" ? "failed" : "succeeded",
      cursor: 3,
      result: { exitCode: offloadResult === "failed" ? 2 : 0 }
    })
  })

  it("preserves GitHub credential checks, mutable PR updates, and unmatched-route responses", async () => {
    const server = await startFakeGitHubServer("desktop-token", { connected: true })
    cleanups.push(server.close)
    const hosted = (path: string, body: unknown) => request(server.url, path, "desktop-token", body)
    expect((await request(server.url, "/api/github/status", "wrong", undefined, "GET")).status).toBe(401)
    const credential = await hosted("/api/github/installation-credentials", {
      installationId: "101", scopes: ["repository:acme/widget", "pull_requests:write", "contents:write", "issues:write"]
    })
    expect(credential.status).toBe(200)
    const { token } = await credential.json()
    const created = await hosted("/api/github/pull-requests", {
      installationId: "101", repository: "acme/widget", head: "feature", base: "main", title: "Original", body: "First"
    })
    expect(created.status).toBe(201)
    const updated = await request(server.url, "/repos/acme/widget/pulls/900", token, { title: "Updated", body: "Second" }, "PATCH")
    expect(updated.status).toBe(200)
    expect(await updated.json()).toMatchObject({ title: "Updated", body: "Second" })
    const read = await request(server.url, "/repos/acme/widget/pulls/900", token, undefined, "GET")
    expect(server.publishedPr()).toMatchObject({ title: "Updated", body: "Second" })
    expect(await read.json()).toMatchObject({ title: "Original", body: "First" })
    for (const path of ["/api/github/unknown", "/repos/acme/widget/pulls/900/unknown", "/repos/acme/widget/issues/900/unknown"]) {
      const accessToken = path.startsWith("/api/") ? "desktop-token" : token
      expect((await request(server.url, path, accessToken, undefined, "GET")).status).toBe(404)
    }
  })
})
