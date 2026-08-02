import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import type { CliKind, MemoryGrantResponse } from "@jingler/core"
import { MEMORY_MCP_PROTOCOL_VERSION } from "@jingler/core"
import { Effect, Layer } from "effect"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ConfigService } from "./config.js"
import {
  EMPTY_MEMORY_RETRIEVAL_SUMMARY,
  makeMemoryService,
  memoryDigestContent,
  recordMemoryRetrieval,
  redactMemoryText,
  type MemorySessionDigestInput
} from "./memory.js"
import { codexMcpEnvironment, codexMcpOverrides } from "./mcp-config.js"
import { makeInMemorySecretStore, SecretStore } from "./secret-store.js"
import { withTempRoot } from "./test-support.js"

const NOW_SECONDS = 1_785_600_000
const ORGANIZATION_ID = "org-paid-team"
const BASE_URL = "https://memory.jingler.test"

const grantResponse = (
  suffix: string,
  expiresAt = NOW_SECONDS + 300
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
      expect(attachment?.instructions).toContain("stable page, revision, source, and citation")
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

    const discoveries = requests.filter((request) => request.url.endsWith("/api/mcp"))
    expect(discoveries).toHaveLength(3)
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

describe("MemoryService settled-session capture", () => {
  it("enqueues at most one bounded redacted source digest with aggregate-only retrieval data", async () => {
    const requests: Request[] = []
    const fetchImplementation: typeof fetch = async (input, init) => {
      const request = requestOf(input, init)
      requests.push(request)
      return request.url.endsWith("/api/memory/grant")
        ? Response.json(grantResponse("capture"))
        : Response.json({ accepted: true }, { status: 202 })
    }
    const service = makeMemoryService({
      fetch: fetchImplementation,
      baseUrl: () => BASE_URL,
      nowSeconds: () => NOW_SECONDS
    })
    const input: MemorySessionDigestInput = {
      sessionId: "session-sensitive-local-id",
      chatId: "chat-sensitive-local-id",
      turnId: "turn-sensitive-local-id",
      cli: "claude",
      userText:
        "Email me at person@example.com; Authorization: Bearer live-bearer and api_key=sk-live123456789 from /Users/private/repo.",
      assistantText:
        "Done. mcp-session-id=session-private password=hunter2 https://x.test/?token=query-secret",
      settledAt: "2026-08-01T12:00:00.000Z",
      retrieval: { searches: 2, reads: 3, navigation: 1, graphReads: 4, proposals: 1 }
    }

    const outcomes = await Effect.runPromise(
      withEnabledMemory(
        Effect.all([
          service.captureSettledSession(input),
          service.captureSettledSession(input),
          service.captureSettledSession(input)
        ], { concurrency: "unbounded" }).pipe(
          Effect.tap(() => Effect.sleep("20 millis"))
        )
      ).pipe(Effect.provide(configuredLayer()))
    )

    expect(outcomes.filter(Boolean)).toHaveLength(1)
    const sourceRequests = requests.filter((request) => request.url.endsWith("/api/memory/sources"))
    expect(sourceRequests).toHaveLength(1)
    const sourceRequest = sourceRequests[0]!
    expect(sourceRequest.headers.get("x-idempotency-key")).toMatch(/^session-digest:[a-f0-9]{64}$/)
    expect(sourceRequest.headers.get("cookie")).toBeNull()
    expect(sourceRequest.headers.get("mcp-session-id")).toBeNull()
    const body: unknown = await sourceRequest.json()
    const serialized = JSON.stringify(body)
    for (const secret of [
      "live-bearer",
      "sk-live123456789",
      "person@example.com",
      "session-private",
      "hunter2",
      "query-secret",
      "/Users/private",
      "session-sensitive-local-id",
      "chat-sensitive-local-id",
      "turn-sensitive-local-id"
    ]) {
      expect(serialized).not.toContain(secret)
    }
    expect(body).toMatchObject({
      source: { kind: "conversation", title: "Settled Jingler agent session" },
      retrieval: { searches: 2, reads: 3, navigation: 1, graphReads: 4, proposals: 1 }
    })
    expect(serialized).not.toContain("duration")
    expect(serialized).not.toContain("query")
    expect(serialized).not.toContain("resultBody")
  })

  it("serializes concurrent enqueues so no queued capture is lost", async () => {
    // Grant succeeds but every source POST is 503, so nothing is ever removed
    // from the outbox — both distinct captures must remain queued. Without the
    // outbox lock, the two concurrent read+write cycles interleave and one
    // enqueue clobbers the other with a stale single-element snapshot.
    const fetchImplementation: typeof fetch = async (input) =>
      String(input).endsWith("/api/memory/grant")
        ? Response.json(grantResponse("serialize"))
        : Response.json({ error: "offline" }, { status: 503 })
    const service = makeMemoryService({
      fetch: fetchImplementation,
      baseUrl: () => BASE_URL,
      nowSeconds: () => NOW_SECONDS
    })
    const inputFor = (suffix: string): MemorySessionDigestInput => ({
      sessionId: `session-${suffix}`,
      chatId: `chat-${suffix}`,
      turnId: `turn-${suffix}`,
      cli: "claude",
      userText: `Request ${suffix}.`,
      assistantText: `Done ${suffix}.`,
      settledAt: "2026-08-01T12:00:00.000Z",
      retrieval: EMPTY_MEMORY_RETRIEVAL_SUMMARY
    })

    await Effect.runPromise(
      withEnabledMemory(
        Effect.all(
          [
            service.captureSettledSession(inputFor("alpha")),
            service.captureSettledSession(inputFor("beta"))
          ],
          { concurrency: "unbounded" }
        ).pipe(Effect.tap(() => Effect.sleep("40 millis")))
      ).pipe(Effect.provide(configuredLayer()))
    )

    const outbox: unknown = JSON.parse(
      readFileSync(join(temp.root, "memory-capture-outbox.json"), "utf8")
    )
    expect(outbox).toHaveLength(2)
  })

  it("allows a later retry after a transient capture failure", async () => {
    let sourceAttempts = 0
    const fetchImplementation: typeof fetch = async (input) => {
      if (String(input).endsWith("/api/memory/grant")) {
        return Response.json(grantResponse("retry"))
      }
      if (String(input).endsWith("/api/memory/organizations")) {
        return Response.json({ organizations: [{
          id: ORGANIZATION_ID,
          name: "Paid team",
          role: "member",
          privileges: ["read", "propose"]
        }] })
      }
      sourceAttempts += 1
      return sourceAttempts === 1
        ? Response.json({ error: "offline" }, { status: 503 })
        : Response.json({ accepted: true }, { status: 202 })
    }
    const service = makeMemoryService({
      fetch: fetchImplementation,
      baseUrl: () => BASE_URL,
      nowSeconds: () => NOW_SECONDS
    })
    const input: MemorySessionDigestInput = {
      sessionId: "session-retry",
      chatId: "chat-retry",
      turnId: "turn-retry",
      cli: "codex",
      userText: "Remember the retry rule.",
      assistantText: "Implemented and verified.",
      settledAt: "2026-08-01T12:00:00.000Z",
      retrieval: EMPTY_MEMORY_RETRIEVAL_SUMMARY
    }

    const outcomes = await Effect.runPromise(
      withEnabledMemory(
        Effect.all([
          service.captureSettledSession(input),
          service.captureSettledSession(input),
          service.captureSettledSession(input)
        ], { concurrency: 1 }).pipe(
          Effect.tap(() => Effect.sleep("30 millis"))
        )
      ).pipe(Effect.provide(configuredLayer()))
    )

    expect(outcomes).toStrictEqual([true, false, false])
    const restarted = makeMemoryService({
      fetch: fetchImplementation,
      baseUrl: () => BASE_URL,
      nowSeconds: () => NOW_SECONDS
    })
    await Effect.runPromise(
      withEnabledMemory(restarted.access()).pipe(
        Effect.tap(() => Effect.sleep("30 millis")),
        Effect.provide(configuredLayer())
      )
    )
    expect(sourceAttempts).toBe(2)
  })

  it("releases the capture id after a failed enqueue so a later attempt retries", async () => {
    let sourcePosts = 0
    const fetchImplementation: typeof fetch = async (input) => {
      if (String(input).endsWith("/api/memory/grant")) {
        return Response.json(grantResponse("release"))
      }
      sourcePosts += 1
      return Response.json({ accepted: true }, { status: 202 })
    }
    const service = makeMemoryService({
      fetch: fetchImplementation,
      baseUrl: () => BASE_URL,
      nowSeconds: () => NOW_SECONDS
    })
    const input: MemorySessionDigestInput = {
      sessionId: "session-release",
      chatId: "chat-release",
      turnId: "turn-release",
      cli: "claude",
      userText: "Enqueue must not permanently claim the id on a write failure.",
      assistantText: "Understood.",
      settledAt: "2026-08-01T12:00:00.000Z",
      retrieval: EMPTY_MEMORY_RETRIEVAL_SUMMARY
    }

    // Force the atomic write to fail: the outbox's temp path is a directory, so
    // writeFileString to it throws and enqueue reports "failed".
    const blocker = join(temp.root, "memory-capture-outbox.json.tmp")
    mkdirSync(temp.root, { recursive: true })
    mkdirSync(blocker, { recursive: true })

    const first = await Effect.runPromise(
      withEnabledMemory(
        service.captureSettledSession(input).pipe(Effect.tap(() => Effect.sleep("20 millis")))
      ).pipe(Effect.provide(configuredLayer()))
    )
    expect(first).toBe(false)
    // Nothing persisted and nothing delivered on the failed enqueue.
    expect(existsSync(join(temp.root, "memory-capture-outbox.json"))).toBe(false)
    expect(sourcePosts).toBe(0)

    // Unblock the write; the same settled turn must be re-attemptable and now
    // actually deliver (the released claim no longer blocks it).
    rmSync(blocker, { recursive: true, force: true })
    const second = await Effect.runPromise(
      withEnabledMemory(
        service.captureSettledSession(input).pipe(Effect.tap(() => Effect.sleep("20 millis")))
      ).pipe(Effect.provide(configuredLayer()))
    )
    expect(second).toBe(true)
    expect(sourcePosts).toBe(1)
  })

  it("drops a capture whose org membership was revoked instead of retrying forever", async () => {
    let grants = 0
    const fetchImplementation: typeof fetch = async (input) => {
      if (String(input).endsWith("/api/memory/grant")) {
        grants += 1
        return Response.json({ error: "forbidden" }, { status: 403 })
      }
      if (String(input).endsWith("/api/memory/organizations")) {
        return Response.json({ organizations: [] })
      }
      return Response.json({ accepted: true }, { status: 202 })
    }
    const service = makeMemoryService({
      fetch: fetchImplementation,
      baseUrl: () => BASE_URL,
      nowSeconds: () => NOW_SECONDS
    })
    const input: MemorySessionDigestInput = {
      sessionId: "session-403",
      chatId: "chat-403",
      turnId: "turn-403",
      cli: "codex",
      userText: "Membership was revoked after this settled.",
      assistantText: "Recorded.",
      settledAt: "2026-08-01T12:00:00.000Z",
      retrieval: EMPTY_MEMORY_RETRIEVAL_SUMMARY
    }

    await Effect.runPromise(
      withEnabledMemory(
        service.captureSettledSession(input).pipe(Effect.tap(() => Effect.sleep("30 millis")))
      ).pipe(Effect.provide(configuredLayer()))
    )

    // The 403 drain drops the job rather than leaving it to re-attempt forever.
    const outbox: unknown = JSON.parse(
      readFileSync(join(temp.root, "memory-capture-outbox.json"), "utf8")
    )
    expect(outbox).toHaveLength(0)
    expect(grants).toBe(1)

    // A second drain finds nothing to do — no further grant round-trips.
    await Effect.runPromise(
      withEnabledMemory(service.access()).pipe(
        Effect.tap(() => Effect.sleep("30 millis")),
        Effect.provide(configuredLayer())
      )
    )
    expect(grants).toBe(1)
  })

  it("redacts credential shapes, bounds content, and counts only known memory tools", () => {
    const redacted = redactMemoryText(
      "Cookie: abc123 refresh_token=refresh-secret\n-----BEGIN PRIVATE KEY-----\nprivate\n-----END PRIVATE KEY-----"
    )
    expect(redacted).not.toContain("abc123")
    expect(redacted).not.toContain("refresh-secret")
    expect(redacted).not.toContain("\nprivate\n")

    const content = memoryDigestContent({
      sessionId: "s",
      chatId: "c",
      turnId: "turn-1",
      cli: "opencode",
      userText: "u".repeat(20_000),
      assistantText: "a".repeat(20_000),
      settledAt: "2026-08-01T12:00:00.000Z",
      retrieval: EMPTY_MEMORY_RETRIEVAL_SUMMARY
    })
    expect(content.length).toBeLessThanOrEqual(8_012)
    expect(content).toContain("[TRUNCATED]")

    const counted = [
      "mcp__jingler-memory__memory_search",
      "memory_read",
      "memory_graph_neighborhood",
      "unrelated_tool"
    ].reduce(recordMemoryRetrieval, EMPTY_MEMORY_RETRIEVAL_SUMMARY)
    expect(counted).toStrictEqual({
      searches: 1,
      reads: 1,
      navigation: 0,
      graphReads: 1,
      proposals: 0
    })
  })

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
