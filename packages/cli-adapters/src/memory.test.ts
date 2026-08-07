import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { CliKind, MemoryGrantResponse } from "@jingler/core"
import { MEMORY_MCP_PROTOCOL_VERSION } from "@jingler/core"
import { Context, Effect, Layer } from "effect"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ConfigService } from "./config.js"
import {
  makeMemoryService,
  MemoryService,
  MemoryServiceLive,
  redactMemoryText,
  type MemoryServiceShape
} from "./memory.js"
import type {
  MemoryMcpForwarder,
  MemoryMcpProxy
} from "./memory-mcp-proxy.js"
import { MemoryMcpProxyError } from "./memory-mcp-proxy.js"
import { codexMcpEnvironment, codexMcpOverrides } from "./mcp-config.js"
import { makeInMemorySecretStore, SecretStore } from "./secret-store.js"
import { withTempRoot } from "./test-support.js"

const NOW_SECONDS = 1_785_600_000
const ORGANIZATION_ID = "org-paid-team"
const BASE_URL = "https://memory.jingler.test"

const grantResponse = (
  suffix: string,
  expiresAt = NOW_SECONDS + 3600
): MemoryGrantResponse => ({
  grant: `grant.${suffix}.signature`,
  claims: {
    version: 1,
    issuer: "jingler",
    audience: "jingler-memory",
    subject: "user-1",
    organizationId: ORGANIZATION_ID,
    privileges: ["read", "propose"],
    issuedAt: NOW_SECONDS,
    expiresAt,
    grantId: `grant-${suffix}`
  }
})

const discoveryResponse = (): Response =>
  Response.json({
    jsonrpc: "2.0",
    id: "discovery",
    result: { resultType: "complete", serverInfo: { name: "jingler-team-memory", version: "1" } }
  })

const requestOf = (input: string | URL | Request, init?: RequestInit): Request =>
  new Request(input, init)

let temp: ReturnType<typeof withTempRoot>

beforeEach(() => {
  temp = withTempRoot()
})

afterEach(() => temp.cleanup())

const configuredLayer = (token: string | null = "jingler-user-token") =>
  Layer.mergeAll(
    ConfigService.Default,
    Layer.effect(SecretStore, makeInMemorySecretStore(token)),
    temp.layer
  )

const withEnabledMemory = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  ConfigService.setMemory({ enabled: true, organizationId: ORGANIZATION_ID }).pipe(
    Effect.zipRight(effect)
  )

describe("MemoryServiceLive layer identity", () => {
  it("shares one service when a consumer dependency and the app runtime use the same layer", async () => {
    const RunnerMemory = Context.GenericTag<MemoryServiceShape>(
      "@jingler/test/RunnerMemory"
    )
    const runnerLayer = Layer.effect(RunnerMemory, MemoryService).pipe(
      Layer.provide(MemoryServiceLive)
    )

    const [rpcMemory, runnerMemory] = await Effect.runPromise(
      Effect.all([MemoryService, RunnerMemory]).pipe(
        Effect.provide(Layer.mergeAll(MemoryServiceLive, runnerLayer))
      )
    )

    expect(rpcMemory).toBe(runnerMemory)
  })
})

describe("MemoryService stateless attachment", () => {
  it("attaches the same organization-scoped endpoint and instructions to Claude, Codex, and OpenCode", async () => {
    const requests: Request[] = []
    const fetchImplementation: typeof fetch = async (input, init) => {
      const request = requestOf(input, init)
      requests.push(request)
      return request.url.endsWith("/api/memory/grant")
        ? Response.json(grantResponse("shared"))
        : discoveryResponse()
    }
    const service = makeMemoryService({
      fetch: fetchImplementation,
      baseUrl: () => BASE_URL,
      nowSeconds: () => NOW_SECONDS
    })

    const attachments = await Effect.runPromise(
      withEnabledMemory(
        Effect.forEach(
          ["claude", "codex", "opencode"] satisfies ReadonlyArray<CliKind>,
          (cli) => service.attachment(cli)
        )
      ).pipe(Effect.provide(configuredLayer()))
    )

    expect(attachments.map((entry) => entry?.server.url)).toStrictEqual([
      `${BASE_URL}/api/mcp`,
      `${BASE_URL}/api/mcp`,
      `${BASE_URL}/api/mcp`
    ])
    for (const attachment of attachments) {
      expect(attachment?.server.name).toBe("jingler-memory")
      expect(attachment?.server.headers["x-jingler-organization-id"]).toBe(ORGANIZATION_ID)
      expect(attachment?.server.headers["mcp-protocol-version"]).toBe(
        MEMORY_MCP_PROTOCOL_VERSION
      )
      expect(attachment?.server.headerEnvironment).toStrictEqual({
        authorization: "JINGLER_MEMORY_AUTHORIZATION"
      })
      expect(attachment?.instructions).toContain("memory_navigation")
      expect(attachment?.instructions).toContain(
        "page, revision, source, and citation identifiers"
      )
      expect(attachment?.instructions).toContain("memory_workflow_status")
    }
    const codexServer = attachments[1]?.server
    expect(codexServer).toBeDefined()
    if (codexServer !== undefined) {
      expect(JSON.stringify(codexMcpOverrides([codexServer]))).not.toContain(
        "grant.shared.signature"
      )
      expect(codexMcpEnvironment([codexServer])).toStrictEqual({
        JINGLER_MEMORY_AUTHORIZATION: "Bearer grant.shared.signature"
      })
    }

    const grants = requests.filter((request) => request.url.endsWith("/api/memory/grant"))
    const discoveries = requests.filter((request) => request.url.endsWith("/api/mcp"))
    expect(grants).toHaveLength(1)
    expect(discoveries).toHaveLength(1)
    for (const request of discoveries) {
      expect(request.headers.get("mcp-protocol-version")).toBe(MEMORY_MCP_PROTOCOL_VERSION)
      expect(request.headers.get("mcp-method")).toBe("server/discover")
      expect(request.headers.get("mcp-session-id")).toBeNull()
      expect(request.headers.get("cookie")).toBeNull()
      const body: unknown = await request.json()
      expect(body).toMatchObject({
        method: "server/discover",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": MEMORY_MCP_PROTOCOL_VERSION,
            "io.modelcontextprotocol/clientInfo": {
              name: "jingler-desktop",
              version: "1.0.0"
            },
            "io.modelcontextprotocol/clientCapabilities": {}
          }
        }
      })
      expect(JSON.stringify(body)).not.toContain("initialize")
    }
  })

  it("refreshes an expired upstream grant without changing a running harness attachment", async () => {
    const requests: Request[] = []
    let grants = 0
    let forwardedCalls = 0
    let forwarder: MemoryMcpForwarder | undefined
    const proxy: MemoryMcpProxy = {
      register: (_key, forward) => {
        forwarder = forward
        return Effect.succeed({
          name: "jingler-memory",
          url: "http://127.0.0.1:32124/mcp/stable",
          headers: { Authorization: "Bearer local-only" },
          headerEnvironment: { Authorization: "JINGLER_MEMORY_AUTHORIZATION" }
        })
      }
    }
    const fetchImplementation: typeof fetch = async (input, init) => {
      const request = requestOf(input, init)
      requests.push(request)
      if (request.url.endsWith("/api/memory/grant")) {
        grants += 1
        return Response.json(grantResponse(`proxy-${grants}`))
      }
      const body = (await request.clone().json()) as {
        method?: string
        params?: { name?: string }
      }
      if (body.method === "server/discover") return discoveryResponse()
      forwardedCalls += 1
      if (forwardedCalls === 1) {
        return Response.json({ error: "expired" }, { status: 401 })
      }
      return Response.json({
        jsonrpc: "2.0",
        id: "late",
        result: { content: [{ type: "text", text: "stored" }] }
      })
    }
    const service = makeMemoryService({
      fetch: fetchImplementation,
      baseUrl: () => BASE_URL,
      nowSeconds: () => NOW_SECONDS,
      proxy
    })

    const attachment = await Effect.runPromise(
      withEnabledMemory(service.attachment("claude")).pipe(
        Effect.provide(configuredLayer())
      )
    )
    expect(attachment?.server.url).toBe("http://127.0.0.1:32124/mcp/stable")
    expect(attachment?.server.headers).toStrictEqual({
      Authorization: "Bearer local-only"
    })
    expect(forwarder).toBeDefined()

    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: "late",
      method: "tools/call",
      params: { name: "memory_propose", arguments: { pageId: "late" } }
    })
    const response = await forwarder?.({
      body,
      protocolVersion: MEMORY_MCP_PROTOCOL_VERSION
    })
    expect(response?.status).toBe(200)
    expect(grants).toBe(2)

    const forwarded = requests.filter((request) => {
      if (!request.url.endsWith("/api/mcp")) return false
      return request.headers.get("mcp-method") === null
    })
    expect(forwarded).toHaveLength(2)
    expect(forwarded.map((request) => request.headers.get("authorization"))).toStrictEqual([
      "Bearer grant.proxy-1.signature",
      "Bearer grant.proxy-2.signature"
    ])
    expect(forwarded.every((request) => request.headers.get("mcp-session-id") === null)).toBe(true)
    expect(forwarded.every((request) => request.headers.get("cookie") === null)).toBe(true)
    expect(forwarded.every((request) => request.headers.get("mcp-name") === null)).toBe(true)
  })

  it("fails closed when the private loopback proxy cannot register", async () => {
    const proxy: MemoryMcpProxy = {
      register: () => Effect.fail(new MemoryMcpProxyError({
        message: "loopback unavailable",
        cause: null
      }))
    }
    const fetchImplementation: typeof fetch = async (input) =>
      String(input).endsWith("/api/memory/grant")
        ? Response.json(grantResponse("proxy-failed"))
        : discoveryResponse()
    const service = makeMemoryService({
      fetch: fetchImplementation,
      baseUrl: () => BASE_URL,
      nowSeconds: () => NOW_SECONDS,
      proxy
    })

    const attachment = await Effect.runPromise(
      withEnabledMemory(service.attachment("claude")).pipe(
        Effect.provide(configuredLayer())
      )
    )

    expect(attachment).toBeNull()
  })

  it("searches and loads a bounded accepted working set before the harness starts", async () => {
    const requests: Request[] = []
    const fetchImplementation: typeof fetch = async (input, init) => {
      const request = requestOf(input, init)
      requests.push(request)
      if (request.url.endsWith("/api/memory/grant")) {
        return Response.json(grantResponse("automatic-recall"))
      }

      const body = (await request.clone().json()) as {
        method?: string
        params?: { name?: string; arguments?: { pageId?: string } }
      }
      if (body.method === "server/discover") return discoveryResponse()
      const name = body.params?.name
      const pageId = body.params?.arguments?.pageId ?? ""
      const data =
        name === "memory_search"
          ? {
              results: ["one", "two", "three", "four"].map((id) => ({
                pageId: `page-${id}`,
                revisionId: `revision:page-${id}:1`
              }))
            }
          : {
              page: {
                id: pageId,
                title: `Title ${pageId}`,
                body: `Accepted body for ${pageId}`
              },
              revision: { id: `revision:${pageId}:1` },
              sourceIds: [`source:${pageId}`],
              citationIds: [`citation:${pageId}`]
            }
      return Response.json({
        jsonrpc: "2.0",
        id: "tool",
        result: { resultType: "complete", structuredContent: { data } }
      })
    }
    const service = makeMemoryService({
      fetch: fetchImplementation,
      baseUrl: () => BASE_URL,
      nowSeconds: () => NOW_SECONDS
    })

    const attachment = await Effect.runPromise(
      withEnabledMemory(
        service.attachment(
          "codex",
          "How do refunds work? api_key=secret-should-not-egress",
          "session-1:chat-1"
        )
      ).pipe(
        Effect.provide(configuredLayer())
      )
    )

    const repeated = await Effect.runPromise(
      withEnabledMemory(
        service.attachment("codex", "How do refunds work?", "session-1:chat-1")
      ).pipe(Effect.provide(configuredLayer()))
    )
    const separateConversation = await Effect.runPromise(
      withEnabledMemory(
        service.attachment("codex", "How do refunds work?", "session-2:chat-1")
      ).pipe(Effect.provide(configuredLayer()))
    )

    expect(attachment?.instructions).toContain("<recalled-memories>")
    expect(attachment?.instructions).toContain("Accepted body for page-one")
    expect(attachment?.instructions).toContain('"revisionId": "revision:page-one:1"')
    expect(attachment?.instructions).not.toContain("page-four")
    expect(repeated?.instructions).not.toContain("Accepted body for page-one")
    expect(separateConversation?.instructions).toContain("Accepted body for page-one")

    const calls = requests.filter(
      (request) => request.headers.get("mcp-method") === "tools/call"
    )
    expect(calls.map((request) => request.headers.get("mcp-name"))).toStrictEqual([
      "memory_search",
      "memory_read",
      "memory_read",
      "memory_read",
      "memory_search",
      "memory_search",
      "memory_read",
      "memory_read",
      "memory_read"
    ])
    expect(calls.every((request) => request.headers.get("cookie") === null)).toBe(true)
    expect(calls.every((request) => request.headers.get("mcp-session-id") === null)).toBe(true)
    const searchBody = (await calls[0]!.json()) as {
      params: { arguments: { query: string } }
    }
    expect(searchBody.params.arguments.query).toContain("api_key=[REDACTED]")
    expect(searchBody.params.arguments.query).not.toContain("secret-should-not-egress")
  })

  it("does not attach team memory to Cursor, which Jingler cannot launch", async () => {
    const fetchImplementation = vi.fn<typeof fetch>()
    const service = makeMemoryService({
      fetch: fetchImplementation,
      baseUrl: () => BASE_URL,
      nowSeconds: () => NOW_SECONDS
    })

    const attachment = await Effect.runPromise(
      withEnabledMemory(service.attachment("cursor")).pipe(
        Effect.provide(configuredLayer())
      )
    )

    expect(attachment).toBeNull()
    expect(fetchImplementation).not.toHaveBeenCalled()
  })

  it("reissues an expired-at-use grant and retries discovery without session state", async () => {
    const requests: Request[] = []
    let grants = 0
    let discoveries = 0
    const fetchImplementation: typeof fetch = async (input, init) => {
      const request = requestOf(input, init)
      requests.push(request)
      if (request.url.endsWith("/api/memory/grant")) {
        grants += 1
        return Response.json(grantResponse(String(grants)))
      }
      if (request.url.endsWith("/api/memory/organizations")) {
        return Response.json({
          organizations: [{
            id: ORGANIZATION_ID,
            name: "Paid team",
            role: "admin",
            privileges: ["read", "propose", "review"]
          }]
        })
      }
      discoveries += 1
      return discoveries === 1
        ? Response.json({ error: "expired" }, { status: 401 })
        : discoveryResponse()
    }
    const service = makeMemoryService({
      fetch: fetchImplementation,
      baseUrl: () => BASE_URL,
      nowSeconds: () => NOW_SECONDS
    })
    const attachment = await Effect.runPromise(
      withEnabledMemory(service.attachment("codex")).pipe(Effect.provide(configuredLayer()))
    )

    expect(attachment?.server.url).toBe(`${BASE_URL}/api/mcp`)
    expect(grants).toBe(2)
    expect(discoveries).toBe(2)
    expect(requests.every((request) => request.headers.get("mcp-session-id") === null)).toBe(true)
    expect(requests.every((request) => request.headers.get("cookie") === null)).toBe(true)
  })

  it("fails open when disabled, signed out, ineligible, expired, unsupported, or unavailable", async () => {
    const unavailable: typeof fetch = async () => Promise.reject(new Error("offline"))
    const ineligible: typeof fetch = async () => Response.json({}, { status: 403 })
    const expired: typeof fetch = async () => Response.json(grantResponse("expired", NOW_SECONDS))
    const unsupported: typeof fetch = async (input) =>
      String(input).endsWith("/api/memory/grant")
        ? Response.json(grantResponse("unsupported"))
        : Response.json({}, { status: 400 })

    const disabled = makeMemoryService({ fetch: ineligible, baseUrl: () => BASE_URL })
    expect(
      await Effect.runPromise(disabled.attachment("claude").pipe(Effect.provide(configuredLayer())))
    ).toBeNull()

    for (const fetchImplementation of [ineligible, expired, unsupported, unavailable]) {
      const service = makeMemoryService({
        fetch: fetchImplementation,
        baseUrl: () => BASE_URL,
        nowSeconds: () => NOW_SECONDS,
        timeoutMs: 20
      })
      expect(
        await Effect.runPromise(
          withEnabledMemory(service.attachment("opencode")).pipe(
            Effect.provide(configuredLayer())
          )
        )
      ).toBeNull()
    }

    const signedOut = makeMemoryService({ fetch: ineligible, baseUrl: () => BASE_URL })
    expect(
      await Effect.runPromise(
        withEnabledMemory(signedOut.attachment("claude")).pipe(
          Effect.provide(configuredLayer(null))
        )
      )
    ).toBeNull()
  })

  it("keeps grants in the main-process service while returning renderer-safe UI data", async () => {
    const requests: Request[] = []
    const fetchImplementation: typeof fetch = async (input, init) => {
      const request = requestOf(input, init)
      requests.push(request)
      if (request.url.endsWith("/api/memory/grant")) {
        const issued = grantResponse("renderer-boundary")
        return Response.json({
          ...issued,
          claims: { ...issued.claims, privileges: ["read", "propose", "review"] }
        })
      }
      if (request.url.endsWith("/api/memory/organizations")) {
        return Response.json({ organizations: [{
          id: ORGANIZATION_ID,
          name: "Paid team",
          role: "admin",
          privileges: ["read", "propose", "review"]
        }] })
      }
      return Response.json({
        jsonrpc: "2.0",
        id: "ui",
        result: {
          resultType: "complete",
          structuredContent: { data: { acceptedPages: 42, scope: ORGANIZATION_ID } },
          content: []
        }
      })
    }
    const service = makeMemoryService({
      fetch: fetchImplementation,
      baseUrl: () => BASE_URL,
      nowSeconds: () => NOW_SECONDS
    })

    const outcome = await Effect.runPromise(
      withEnabledMemory(
        Effect.gen(function* () {
          const access = yield* service.access()
          const data = yield* service.uiRequest({
            organizationId: ORGANIZATION_ID,
            name: "memory_dashboard",
            arguments: { range: "30d" }
          })
          return { access, data }
        })
      ).pipe(Effect.provide(configuredLayer()))
    )

    expect(outcome).toStrictEqual({
      access: {
        selectedOrganizationId: ORGANIZATION_ID,
        organizations: [{
          id: ORGANIZATION_ID,
          name: "Paid team",
          role: "admin",
          privileges: ["read", "propose", "review"]
        }]
      },
      data: { acceptedPages: 42, scope: ORGANIZATION_ID }
    })
    expect(JSON.stringify(outcome)).not.toContain("grant.renderer-boundary.signature")
    expect(JSON.stringify(outcome)).not.toContain("jingler-user-token")

    const toolRequest = requests.find((request) => request.url.endsWith("/api/mcp"))
    expect(toolRequest).toBeDefined()
    if (toolRequest === undefined) return
    expect(toolRequest.headers.get("authorization")).toBe(
      "Bearer grant.renderer-boundary.signature"
    )
    expect(toolRequest.headers.get("x-jingler-organization-id")).toBe(ORGANIZATION_ID)
    expect(toolRequest.headers.get("mcp-method")).toBe("tools/call")
    expect(toolRequest.headers.get("mcp-name")).toBe("memory_dashboard")
    expect(toolRequest.headers.get("mcp-session-id")).toBeNull()
    expect(toolRequest.headers.get("cookie")).toBeNull()
    const body: unknown = await toolRequest.json()
    expect(body).toMatchObject({
      method: "tools/call",
      params: { name: "memory_dashboard", arguments: { range: "30d" } }
    })
    expect(JSON.stringify(body)).not.toContain("grant.renderer-boundary.signature")
    expect(JSON.stringify(body)).not.toContain("jingler-user-token")
  })

  it("mints one grant per organization and reuses it across parallel UI requests", async () => {
    const grantedOrgs: string[] = []
    const toolResponse = (): Response =>
      Response.json({
        jsonrpc: "2.0",
        id: "ui",
        result: { resultType: "complete", structuredContent: { data: { ok: true } }, content: [] }
      })
    const grantForOrg = (organizationId: string): MemoryGrantResponse => {
      const base = grantResponse(organizationId)
      return {
        grant: `grant.${organizationId}.signature`,
        claims: { ...base.claims, organizationId, grantId: `grant-${organizationId}` }
      }
    }
    const fetchImplementation: typeof fetch = async (input, init) => {
      const request = requestOf(input, init)
      if (request.url.endsWith("/api/memory/grant")) {
        const parsed = (await request.json()) as { organizationId: string }
        grantedOrgs.push(parsed.organizationId)
        return Response.json(grantForOrg(parsed.organizationId))
      }
      return toolResponse()
    }
    const service = makeMemoryService({
      fetch: fetchImplementation,
      baseUrl: () => BASE_URL,
      nowSeconds: () => NOW_SECONDS
    })

    await Effect.runPromise(
      withEnabledMemory(
        Effect.all(
          [
            service.uiRequest({ organizationId: ORGANIZATION_ID, name: "memory_dashboard", arguments: {} }),
            service.uiRequest({ organizationId: ORGANIZATION_ID, name: "memory_graph", arguments: {} }),
            service.uiRequest({ organizationId: ORGANIZATION_ID, name: "memory_search", arguments: {} }),
            service.uiRequest({ organizationId: "org-second", name: "memory_dashboard", arguments: {} })
          ],
          { concurrency: "unbounded" }
        )
      ).pipe(Effect.provide(configuredLayer()))
    )

    // Three same-org requests share a single minted grant; the second org gets its own.
    expect(grantedOrgs.filter((org) => org === ORGANIZATION_ID)).toHaveLength(1)
    expect(grantedOrgs.filter((org) => org === "org-second")).toHaveLength(1)
  })

  it("re-mints a cached grant once it nears expiry", async () => {
    let now = NOW_SECONDS
    let grants = 0
    const fetchImplementation: typeof fetch = async (input) => {
      if (String(input).endsWith("/api/memory/grant")) {
        grants += 1
        return Response.json(grantResponse(String(grants), NOW_SECONDS + 300))
      }
      return Response.json({
        jsonrpc: "2.0",
        id: "ui",
        result: { resultType: "complete", structuredContent: { data: {} }, content: [] }
      })
    }
    const service = makeMemoryService({
      fetch: fetchImplementation,
      baseUrl: () => BASE_URL,
      nowSeconds: () => now
    })

    await Effect.runPromise(
      withEnabledMemory(
        service.uiRequest({ organizationId: ORGANIZATION_ID, name: "memory_dashboard", arguments: {} })
      ).pipe(Effect.provide(configuredLayer()))
    )
    expect(grants).toBe(1)

    // A follow-up while the grant is comfortably valid reuses the cache.
    await Effect.runPromise(
      withEnabledMemory(
        service.uiRequest({ organizationId: ORGANIZATION_ID, name: "memory_graph", arguments: {} })
      ).pipe(Effect.provide(configuredLayer()))
    )
    expect(grants).toBe(1)

    // Advance into the safety margin of expiry; the next request must re-mint.
    now = NOW_SECONDS + 290
    await Effect.runPromise(
      withEnabledMemory(
        service.uiRequest({ organizationId: ORGANIZATION_ID, name: "memory_search", arguments: {} })
      ).pipe(Effect.provide(configuredLayer()))
    )
    expect(grants).toBe(2)
  })
})

const writeLegacyCaptureOutbox = (
  overrides: Readonly<Record<string, unknown>> = {}
): void => {
  mkdirSync(temp.root, { recursive: true })
  writeFileSync(
    join(temp.root, "memory-capture-outbox.json"),
    `${JSON.stringify([{
      id: "session-digest:legacy",
      organizationId: ORGANIZATION_ID,
      settledAt: "2026-08-01T12:00:00.000Z",
      content: "# Legacy settled session\n\nA pre-upgrade capture.",
      retrieval: { searches: 1, reads: 2, navigation: 0, graphReads: 0, proposals: 0 },
      attempts: 5,
      firstSeenAt: NOW_SECONDS - 60,
      ...overrides
    }])}\n`
  )
}

describe("MemoryService legacy capture recovery", () => {
  it("retains transient pre-upgrade captures without an attempt-count deletion boundary", async () => {
    writeLegacyCaptureOutbox()
    const fetchImplementation: typeof fetch = async (input) =>
      String(input).endsWith("/api/memory/grant")
        ? Response.json(grantResponse("recover"))
        : Response.json({ error: "offline" }, { status: 503 })
    const service = makeMemoryService({
      fetch: fetchImplementation,
      baseUrl: () => BASE_URL,
      nowSeconds: () => NOW_SECONDS
    })

    const recovery = await Effect.runPromise(
      withEnabledMemory(service.recoverCaptures()).pipe(Effect.provide(configuredLayer()))
    )

    expect(recovery).toMatchObject({
      queuedBefore: 1,
      delivered: 0,
      retained: 1,
      discarded: 0,
      lastFailureStatus: 503
    })
    const outbox = JSON.parse(
      readFileSync(join(temp.root, "memory-capture-outbox.json"), "utf8")
    ) as ReadonlyArray<{ readonly attempts: number }>
    expect(outbox).toHaveLength(1)
    expect(outbox[0]?.attempts).toBe(6)
  })

  it("delivers and removes a pre-upgrade capture", async () => {
    writeLegacyCaptureOutbox({ attempts: 0 })
    const requests: Request[] = []
    const fetchImplementation: typeof fetch = async (input, init) => {
      const request = requestOf(input, init)
      requests.push(request)
      return request.url.endsWith("/api/memory/grant")
        ? Response.json(grantResponse("deliver"))
        : Response.json({ accepted: true }, { status: 202 })
    }
    const service = makeMemoryService({
      fetch: fetchImplementation,
      baseUrl: () => BASE_URL,
      nowSeconds: () => NOW_SECONDS
    })

    const recovery = await Effect.runPromise(
      withEnabledMemory(service.recoverCaptures()).pipe(Effect.provide(configuredLayer()))
    )

    expect(recovery).toMatchObject({
      queuedBefore: 1,
      delivered: 1,
      retained: 0,
      discarded: 0,
      lastFailureStatus: null
    })
    const sourceRequest = requests.find((request) =>
      request.url.endsWith("/api/memory/sources")
    )
    expect(sourceRequest?.headers.get("x-idempotency-key")).toBe(
      "session-digest:legacy"
    )
    expect(await sourceRequest?.json()).toMatchObject({
      source: {
        id: "session-digest:legacy",
        kind: "conversation",
        retrievedAt: "2026-08-01T12:00:00.000Z"
      },
      content: "# Legacy settled session\n\nA pre-upgrade capture.",
      retrieval: { searches: 1, reads: 2 }
    })
    expect(JSON.parse(
      readFileSync(join(temp.root, "memory-capture-outbox.json"), "utf8")
    )).toEqual([])
  })

  it("discards a pre-upgrade capture after organization access is revoked", async () => {
    writeLegacyCaptureOutbox()
    const service = makeMemoryService({
      fetch: async () => Response.json({ error: "forbidden" }, { status: 403 }),
      baseUrl: () => BASE_URL,
      nowSeconds: () => NOW_SECONDS
    })

    const recovery = await Effect.runPromise(
      withEnabledMemory(service.recoverCaptures()).pipe(Effect.provide(configuredLayer()))
    )

    expect(recovery).toMatchObject({
      queuedBefore: 1,
      delivered: 0,
      retained: 0,
      discarded: 1,
      lastFailureStatus: null
    })
    expect(JSON.parse(
      readFileSync(join(temp.root, "memory-capture-outbox.json"), "utf8")
    )).toEqual([])
  })
})

describe("automatic recall redaction", () => {
  it("redacts complete cookie headers, continuation lines, and common token assignments", () => {
    const redacted = redactMemoryText([
      "Cookie: theme=light; session_token=supersecret-value",
      "Set-Cookie: harmless=yes; private_key=private-material",
      "\tcontinuation-secret=must-not-survive",
      "  Cookie: theme=light; sid=indented-cookie-secret",
      "Request Cookie: theme=light; sid=prefixed-cookie-secret",
      "secret=abcdefghijklmnop",
      "session_token=qrstuvwxyzabcdef"
    ].join("\n"))

    for (const secret of [
      "supersecret-value",
      "private-material",
      "must-not-survive",
      "indented-cookie-secret",
      "prefixed-cookie-secret",
      "abcdefghijklmnop",
      "qrstuvwxyzabcdef"
    ]) expect(redacted).not.toContain(secret)
  })
})
