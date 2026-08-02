import {
  MEMORY_MCP_ERROR,
  MEMORY_MCP_PROTOCOL_VERSION,
  MEMORY_MCP_SERVER_INFO,
  MemoryGrantResponse,
  type MemoryPrivilege
} from "@jingler/core"
import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { POST as memoryMcpRoute } from "../app/api/mcp/route.js"
import { checkMemoryHealth } from "../app/api/memory/health/route.js"
import { handleMemorySourceRequest } from "../app/api/memory/sources/route.js"
import type { OrganizationAuthorization } from "./db/repositories/organization-repository.js"
import { isActivePaidOrganizationMetadata } from "./db/repositories/organization-repository.js"
import { env, loadEnv } from "./env.js"
import {
  createMemoryClient,
  type JsonValue,
  type MemoryClient,
  type MemoryClientRequest
} from "./memory-client.js"
import {
  handleMemoryMcpRequest,
  rejectMemoryMcpGet,
  type MemoryMcpDependencies
} from "./mcp-memory.js"
import {
  handleMemoryGrantRequest,
  issueMemoryGrant,
  MemoryGrantError,
  verifyMemoryGrant
} from "./memory-grant.js"

const grantConfig = {
  secret: "test-memory-grant-secret",
  audience: "jingler-memory-mcp",
  ttlSeconds: 300
}

const authorization = (
  organizationId: string,
  privileges: ReadonlyArray<MemoryPrivilege> = ["read", "propose"]
): OrganizationAuthorization => ({ organizationId, role: "member", privileges })

const issue = (
  organizationId = "org-paid",
  privileges: ReadonlyArray<MemoryPrivilege> = ["read", "propose"],
  nowSeconds = 100
) =>
  issueMemoryGrant(
    { subject: "user-1", organizationId, privileges },
    grantConfig,
    nowSeconds,
    `grant-${organizationId}`
  )

const metadata = {
  "io.modelcontextprotocol/protocolVersion": MEMORY_MCP_PROTOCOL_VERSION,
  "io.modelcontextprotocol/clientInfo": { name: "test-client", version: "1.0.0" },
  "io.modelcontextprotocol/clientCapabilities": {}
}

const requestFor = (
  method: string,
  grant: string,
  options: {
    readonly organizationId?: string
    readonly params?: Record<string, unknown>
    readonly metadata?: Record<string, unknown>
    readonly headers?: Record<string, string>
  } = {}
): Request => {
  const organizationId = options.organizationId ?? "org-paid"
  const params = options.params ?? {}
  const name = typeof params.name === "string" ? params.name : null
  return new Request("https://jingler.test/api/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${grant}`,
      "content-type": "application/json",
      "mcp-protocol-version": MEMORY_MCP_PROTOCOL_VERSION,
      "mcp-method": method,
      ...(name ? { "mcp-name": name } : {}),
      "x-jingler-organization-id": organizationId,
      ...options.headers
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `${method}-1`,
      method,
      params: { ...params, _meta: options.metadata ?? metadata }
    })
  })
}

const collectingClient = (): {
  readonly client: MemoryClient<JsonValue>
  readonly requests: Array<MemoryClientRequest>
} => {
  const requests: Array<MemoryClientRequest> = []
  return {
    requests,
    client: {
      request: (input) => {
        requests.push(input)
        return Effect.succeed({
          pageId: "page-stable",
          revisionId: "revision-stable",
          sourceId: "source-stable",
          citationId: "citation-stable"
        })
      }
    }
  }
}

const dependenciesFor = (
  client: MemoryClient<JsonValue>,
  expectedNow = 101
): MemoryMcpDependencies => ({
  verifyGrant: (grant, organizationId) =>
    verifyMemoryGrant(grant, {
      secret: grantConfig.secret,
      audience: grantConfig.audience,
      organizationId,
      nowSeconds: expectedNow
    }),
  client,
  requestId: () => "request-stable"
})

describe("memory operations health", () => {
  it("reports disabled without probing Cloudflare", async () => {
    let calls = 0
    const response = await checkMemoryHealth({
      enabled: false,
      workerUrl: "https://memory-worker.test",
      timeoutMs: 100,
      fetch: async () => {
        calls += 1
        return Response.json({ status: "ok" })
      }
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: "disabled" })
    expect(calls).toBe(0)
  })

  it("reports upstream readiness and bounded failure without leaking configuration", async () => {
    const ready = await checkMemoryHealth({
      enabled: true,
      workerUrl: "https://memory-worker.test",
      timeoutMs: 100,
      fetch: async () => Response.json({ status: "ok" })
    })
    expect(ready.status).toBe(200)
    expect(await ready.json()).toEqual({ status: "ok", service: "jingler-memory", upstream: "ok" })

    const degraded = await checkMemoryHealth({
      enabled: true,
      workerUrl: "https://memory-worker.test",
      timeoutMs: 100,
      fetch: async () => {
        throw new Error("upstream unavailable with secret-that-must-not-escape")
      }
    })
    expect(degraded.status).toBe(503)
    expect(JSON.stringify(await degraded.json())).not.toContain("secret-that-must-not-escape")
  })
})

describe("memory production configuration", () => {
  it("requires signing and service secrets in production", () => {
    expect(() => loadEnv({ NODE_ENV: "production" })).toThrow("BETTER_AUTH_SECRET")
    expect(() =>
      loadEnv({ NODE_ENV: "production", BETTER_AUTH_SECRET: "auth-secret" })
    ).toThrow("MEMORY_GRANT_SECRET")
    expect(() =>
      loadEnv({
        NODE_ENV: "production",
        BETTER_AUTH_SECRET: "auth-secret",
        MEMORY_GRANT_SECRET: "grant-secret"
      })
    ).toThrow("MEMORY_WORKER_SERVICE_SECRET")
  })

  it("retains zero-configuration local defaults", () => {
    expect(loadEnv({ NODE_ENV: "test" })).toMatchObject({
      authSecret: "dev-insecure-secret-change-me",
      memoryGrantSecret: "dev-memory-grant-secret-change-me",
      memoryWorkerServiceSecret: "dev-memory-worker-secret-change-me"
    })
  })
})

describe("memory grants", () => {
  it("issues only for the exact active paid organization membership", async () => {
    expect(isActivePaidOrganizationMetadata('{"plan":"team","status":"active"}')).toBe(true)
    expect(
      isActivePaidOrganizationMetadata(
        '{"subscription":{"plan":"enterprise","subscriptionStatus":"active"}}'
      )
    ).toBe(true)
    expect(
      isActivePaidOrganizationMetadata(
        '{"subscription":{"plan":"business","status":"active"},"unrelated":true}'
      )
    ).toBe(true)
    expect(isActivePaidOrganizationMetadata('{"plan":"free","status":"active"}')).toBe(false)
    expect(isActivePaidOrganizationMetadata('{"plan":"team","status":"cancelled"}')).toBe(false)
    expect(isActivePaidOrganizationMetadata('{"subscription":{"plan":"team"}}')).toBe(false)
    expect(isActivePaidOrganizationMetadata("not-json")).toBe(false)
    expect(isActivePaidOrganizationMetadata(null)).toBe(false)

    const makeRequest = (organizationId: string, bearer = "jingler-user-bearer") =>
      new Request("https://jingler.test/api/memory/grant", {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
        body: JSON.stringify({ organizationId })
      })
    const handlerDependencies = {
      getUserId: async (headers: Headers) =>
        headers.get("authorization") === "Bearer jingler-user-bearer" ? "user-1" : null,
      authorize: async (userId: string, organizationId: string) =>
        userId === "user-1" && organizationId === "org-paid"
          ? authorization(organizationId)
          : null,
      issue: (userId: string, allowed: OrganizationAuthorization) =>
        issueMemoryGrant(
          {
            subject: userId,
            organizationId: allowed.organizationId,
            privileges: allowed.privileges
          },
          grantConfig,
          100,
          "grant-1"
        )
    }

    const paid = await handleMemoryGrantRequest(makeRequest("org-paid"), handlerDependencies)
    const paidBody = Schema.decodeUnknownSync(MemoryGrantResponse)(await paid.json())
    expect(paid.status).toBe(200)
    expect(paidBody.claims.organizationId).toBe("org-paid")
    expect(paidBody.claims.privileges).toStrictEqual(["read", "propose"])
    expect(JSON.stringify(paidBody.claims)).not.toContain("jingler-user-bearer")
    expect(Buffer.from(paidBody.grant.split(".")[1] ?? "", "base64url").toString("utf8")).not.toContain(
      "jingler-user-bearer"
    )

    expect(
      (await handleMemoryGrantRequest(makeRequest("org-free"), handlerDependencies)).status
    ).toBe(403)
    expect(
      (await handleMemoryGrantRequest(makeRequest("org-removed"), handlerDependencies)).status
    ).toBe(403)
    expect(
      (await handleMemoryGrantRequest(makeRequest("org-arbitrary"), handlerDependencies)).status
    ).toBe(403)
    expect(
      (await handleMemoryGrantRequest(makeRequest("org-paid", "wrong"), handlerDependencies)).status
    ).toBe(401)
  })

  it("rejects altered, expired, wrong-audience, and wrong-organization grants", () => {
    const valid = issue().grant
    const last = valid.at(-1)
    const altered = `${valid.slice(0, -1)}${last === "a" ? "b" : "a"}`

    expect(() =>
      verifyMemoryGrant(altered, {
        secret: grantConfig.secret,
        audience: grantConfig.audience,
        organizationId: "org-paid",
        nowSeconds: 101
      })
    ).toThrowError(MemoryGrantError)
    expect(() =>
      verifyMemoryGrant(valid, {
        secret: grantConfig.secret,
        audience: "wrong-audience",
        organizationId: "org-paid",
        nowSeconds: 101
      })
    ).toThrow("wrong-audience")
    expect(() =>
      verifyMemoryGrant(valid, {
        secret: grantConfig.secret,
        audience: grantConfig.audience,
        organizationId: "org-other",
        nowSeconds: 101
      })
    ).toThrow("wrong-organization")
    expect(() =>
      verifyMemoryGrant(valid, {
        secret: grantConfig.secret,
        audience: grantConfig.audience,
        organizationId: "org-paid",
        nowSeconds: 400
      })
    ).toThrow("expired")
  })
})

describe("stateless MCP 2026-07-28", () => {
  it("runs discovery through the real Next.js Route Handler", async () => {
    const routeGrant = issueMemoryGrant(
      { subject: "user-route", organizationId: "org-route", privileges: ["read"] },
      {
        secret: env.memoryGrantSecret,
        audience: env.memoryGrantAudience,
        ttlSeconds: env.memoryGrantTtlSeconds
      }
    ).grant
    const response = await memoryMcpRoute(
      requestFor("server/discover", routeGrant, { organizationId: "org-route" })
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      result: {
        resultType: "complete",
        supportedVersions: [MEMORY_MCP_PROTOCOL_VERSION],
        serverInfo: MEMORY_MCP_SERVER_INFO
      }
    })
    expect(response.headers.has("mcp-session-id")).toBe(false)
  })

  it("handles independent discovery, list, and call POSTs with no session state", async () => {
    const { client, requests } = collectingClient()
    const dependencies = dependenciesFor(client)
    const grant = issue(
      "org-paid",
      ["read", "propose", "review", "schema"]
    ).grant

    const discover = await handleMemoryMcpRequest(
      requestFor("server/discover", grant),
      dependencies
    )
    const listOne = await handleMemoryMcpRequest(requestFor("tools/list", grant), dependencies)
    const listTwo = await handleMemoryMcpRequest(requestFor("tools/list", grant), dependencies)
    const call = await handleMemoryMcpRequest(
      requestFor("tools/call", grant, {
        params: {
          name: "memory_search",
          arguments: { query: "launch", limit: 10 }
        }
      }),
      dependencies
    )

    expect(discover.status).toBe(200)
    expect(listOne.status).toBe(200)
    expect(call.status).toBe(200)
    expect(await listTwo.json()).toStrictEqual(await listOne.clone().json())
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      organizationId: "org-paid",
      requestId: "request-stable",
      path: "/internal/memory/search?q=launch&limit=10"
    })
    expect(call.headers.has("mcp-session-id")).toBe(false)
    expect(call.headers.has("set-cookie")).toBe(false)

    const discoverBody = await discover.json()
    const listBody = await listOne.json()
    const callBody = await call.json()
    for (const body of [discoverBody, listBody, callBody]) {
      expect(body).toMatchObject({
        result: {
          resultType: "complete",
          _meta: { "io.modelcontextprotocol/serverInfo": MEMORY_MCP_SERVER_INFO }
        }
      })
    }
    expect(discoverBody).toMatchObject({
      result: {
        supportedVersions: [MEMORY_MCP_PROTOCOL_VERSION],
        ttlMs: 60_000,
        cacheScope: "private"
      }
    })
    expect(listBody).toMatchObject({ result: { ttlMs: 60_000, cacheScope: "private" } })
    expect(discover.headers.get("cache-control")).toBe("private, max-age=60")
    expect(listOne.headers.get("cache-control")).toBe("private, max-age=60")
    expect(callBody).toMatchObject({
      result: {
        structuredContent: {
          data: {
            pageId: "page-stable",
            revisionId: "revision-stable",
            sourceId: "source-stable",
            citationId: "citation-stable"
          }
        }
      }
    })
  })

  it("filters tools by grant privileges", async () => {
    const { client } = collectingClient()
    const memberResponse = await handleMemoryMcpRequest(
      requestFor("tools/list", issue().grant),
      dependenciesFor(client)
    )
    const memberBody = await memberResponse.json()
    expect(memberBody.result.tools.map((tool: { name: string }) => tool.name)).not.toContain(
      "memory_review"
    )
    expect(memberBody.result.tools.map((tool: { name: string }) => tool.name)).not.toContain(
      "memory_schema_publish"
    )
  })

  it("rejects invalid grants and unsupported or mismatched protocol requests", async () => {
    const { client } = collectingClient()
    const dependencies = dependenciesFor(client)
    const valid = issue().grant
    const altered = `${valid.slice(0, -1)}${valid.at(-1) === "a" ? "b" : "a"}`

    const alteredResponse = await handleMemoryMcpRequest(
      requestFor("tools/list", altered),
      dependencies
    )
    expect(alteredResponse.status).toBe(401)

    const wrongOrganization = await handleMemoryMcpRequest(
      requestFor("tools/list", valid, { organizationId: "org-other" }),
      dependencies
    )
    expect(wrongOrganization.status).toBe(401)

    const wrongAudienceGrant = issueMemoryGrant(
      { subject: "user-1", organizationId: "org-paid", privileges: ["read"] },
      { ...grantConfig, audience: "another-service" },
      100,
      "grant-wrong-audience"
    ).grant
    const wrongAudience = await handleMemoryMcpRequest(
      requestFor("tools/list", wrongAudienceGrant),
      dependencies
    )
    expect(wrongAudience.status).toBe(401)

    const unsupported = await handleMemoryMcpRequest(
      requestFor("tools/list", valid, {
        headers: { "mcp-protocol-version": "2025-11-25" }
      }),
      dependencies
    )
    expect(unsupported.status).toBe(400)
    expect(await unsupported.json()).toMatchObject({
      error: { code: MEMORY_MCP_ERROR.unsupportedProtocolVersion }
    })

    const mismatch = await handleMemoryMcpRequest(
      requestFor("tools/list", valid, { headers: { "mcp-method": "tools/call" } }),
      dependencies
    )
    expect(mismatch.status).toBe(400)
    expect(await mismatch.json()).toMatchObject({ error: { code: MEMORY_MCP_ERROR.headerMismatch } })

    const missingMetadata = await handleMemoryMcpRequest(
      requestFor("tools/list", valid, { metadata: {} }),
      dependencies
    )
    expect(missingMetadata.status).toBe(400)
    expect(await missingMetadata.json()).toMatchObject({
      error: { code: MEMORY_MCP_ERROR.missingClientCapability }
    })

    const missingName = await handleMemoryMcpRequest(
      requestFor("tools/call", valid, {
        params: { name: "memory_search", arguments: { query: "launch" } },
        headers: { "mcp-name": "" }
      }),
      dependencies
    )
    expect(missingName.status).toBe(400)
    expect(await missingName.json()).toMatchObject({
      error: { code: MEMORY_MCP_ERROR.headerMismatch }
    })

    const expiredDependencies = dependenciesFor(client, 401)
    const expired = await handleMemoryMcpRequest(
      requestFor("tools/list", valid),
      expiredDependencies
    )
    expect(expired.status).toBe(401)
  })

  it("does not implement initialize, GET transport, or a session id", async () => {
    const { client } = collectingClient()
    const initialized = await handleMemoryMcpRequest(
      requestFor("initialize", issue().grant),
      dependenciesFor(client)
    )
    const get = rejectMemoryMcpGet()

    expect(initialized.status).toBe(404)
    expect(await initialized.json()).toMatchObject({ error: { code: -32601 } })
    expect(get.status).toBe(405)
    expect(get.headers.get("allow")).toBe("POST")
    expect(get.headers.has("mcp-session-id")).toBe(false)
  })

  it("enforces the constraints advertised by tool input schemas", async () => {
    const { client, requests } = collectingClient()
    const grant = issue().grant
    const dependencies = dependenciesFor(client)
    const responses = await Promise.all([
      { query: "", limit: 10 },
      { query: "launch", limit: 101 },
      { query: "launch", limit: 1.5 },
      { query: "launch", extra: true }
    ].map((argumentsValue) =>
      handleMemoryMcpRequest(
        requestFor("tools/call", grant, { params: { name: "memory_search", arguments: argumentsValue } }),
        dependencies
      )))
    const bodies = await Promise.all(responses.map((response) => response.json()))
    for (const body of bodies) {
      expect(body).toMatchObject({ error: { code: -32602 } })
    }
    expect(requests).toHaveLength(0)
  })

  it("maps schema publication arguments to the Worker accepted-page contract", async () => {
    const { client, requests } = collectingClient()
    const response = await handleMemoryMcpRequest(
      requestFor("tools/call", issue("org-paid", ["read", "schema"]).grant, {
        params: {
          name: "memory_schema_publish",
          arguments: { revisionId: "revision-schema-1", markdown: "---\nid: schema\n---\n" }
        }
      }),
      dependenciesFor(client)
    )
    expect(response.status).toBe(200)
    expect(requests[0]).toMatchObject({
      path: "/internal/memory/pages",
      body: {
        revisionId: "revision-schema-1",
        markdown: "---\nid: schema\n---\n",
        actorId: "user-1"
      }
    })
    const request = requests[0]
    expect(request).toBeDefined()
    if (request === undefined) return
    expect((request.body as { createdAt?: string }).createdAt).toMatch(/^\d{4}-/)
  })
})

describe("private Memory Worker client", () => {
  it("adds only the rotating service credential, organization scope, and request id", async () => {
    const capturedRequests: Array<Request> = []
    const fetchImplementation: typeof fetch = async (input, init) => {
      capturedRequests.push(new Request(input, init))
      return Response.json({ pageId: "page-1", revisionId: "revision-1" })
    }
    const client = createMemoryClient(
      {
        baseUrl: "https://memory-worker.test",
        serviceSecret: "rotating-service-secret",
        timeoutMs: 100
      },
      Schema.Struct({ pageId: Schema.String, revisionId: Schema.String }),
      fetchImplementation
    )
    const result = await Effect.runPromise(
      client.request({
        organizationId: "org-1",
        requestId: "request-1",
        method: "GET",
        path: "/internal/memory/pages/page-1"
      })
    )

    expect(result).toStrictEqual({ pageId: "page-1", revisionId: "revision-1" })
    expect(capturedRequests[0]?.headers.get("authorization")).toBe(
      "Bearer rotating-service-secret"
    )
    expect(capturedRequests[0]?.headers.get("x-jingler-organization-id")).toBe("org-1")
    expect(capturedRequests[0]?.headers.get("x-request-id")).toBe("request-1")
  })

  it("decodes an expected stale-review conflict instead of converting it to transport failure", async () => {
    const client = createMemoryClient(
      {
        baseUrl: "https://memory-worker.test",
        serviceSecret: "rotating-service-secret",
        timeoutMs: 100
      },
      Schema.Struct({
        status: Schema.Literal("conflict"),
        conflicts: Schema.Array(Schema.Struct({ pageId: Schema.String }))
      }),
      async () => Response.json(
        { status: "conflict", conflicts: [{ pageId: "page-1" }] },
        { status: 409 }
      )
    )
    await expect(Effect.runPromise(client.request({
      organizationId: "org-1",
      requestId: "request-conflict",
      method: "POST",
      path: "/internal/memory/proposals/proposal-1/approve",
      acceptedStatuses: [409]
    }))).resolves.toEqual({ status: "conflict", conflicts: [{ pageId: "page-1" }] })
  })
})

describe("settled-session source ingestion", () => {
  it("accepts one grant-scoped digest and forwards it with only the service credential", async () => {
    const { client, requests } = collectingClient()
    const grant = issueMemoryGrant(
      { subject: "user-route", organizationId: "org-route", privileges: ["propose"] },
      {
        secret: env.memoryGrantSecret,
        audience: env.memoryGrantAudience,
        ttlSeconds: env.memoryGrantTtlSeconds
      }
    ).grant
    const sourceId = "session-digest:stable"
    const response = await handleMemorySourceRequest(
      new Request("https://jingler.test/api/memory/sources", {
        method: "POST",
        headers: {
          authorization: `Bearer ${grant}`,
          "content-type": "application/json",
          "x-idempotency-key": sourceId,
          "x-jingler-organization-id": "org-route"
        },
        body: JSON.stringify({
          source: {
            id: sourceId,
            kind: "conversation",
            title: "Settled Jingler agent session"
          },
          content: "A bounded redacted result.",
          retrieval: { searches: 2, reads: 3, navigation: 1, graphReads: 4, proposals: 1 }
        })
      }),
      {
        verifyGrant: (candidate, organizationId) =>
          verifyMemoryGrant(candidate, {
            secret: env.memoryGrantSecret,
            audience: env.memoryGrantAudience,
            organizationId
          }),
        client
      }
    )

    expect(response.status).toBe(201)
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      organizationId: "org-route",
      path: "/internal/memory/sources",
      method: "POST",
      body: {
        retrieval: { searches: 2, reads: 3, navigation: 1, graphReads: 4, proposals: 1 }
      }
    })
    expect(JSON.stringify(requests[0])).not.toContain(grant)
    expect(JSON.stringify(requests[0])).not.toContain("query")
  })

  it("rejects read-only grants and mismatched idempotency keys before Cloudflare", async () => {
    const { client, requests } = collectingClient()
    const makeSourceRequest = (privileges: ReadonlyArray<MemoryPrivilege>, key: string) => {
      const grant = issueMemoryGrant(
        { subject: "user-route", organizationId: "org-route", privileges },
        {
          secret: env.memoryGrantSecret,
          audience: env.memoryGrantAudience,
          ttlSeconds: env.memoryGrantTtlSeconds
        }
      ).grant
      return new Request("https://jingler.test/api/memory/sources", {
        method: "POST",
        headers: {
          authorization: `Bearer ${grant}`,
          "content-type": "application/json",
          "x-idempotency-key": key,
          "x-jingler-organization-id": "org-route"
        },
        body: JSON.stringify({
          source: { id: "session-digest:stable", kind: "conversation", title: "Settled" },
          content: "redacted"
        })
      })
    }

    const dependencies = {
      verifyGrant: (candidate: string, organizationId: string) =>
        verifyMemoryGrant(candidate, {
          secret: env.memoryGrantSecret,
          audience: env.memoryGrantAudience,
          organizationId
        }),
      client
    }
    expect(
      (await handleMemorySourceRequest(
        makeSourceRequest(["read"], "session-digest:stable"),
        dependencies
      )).status
    ).toBe(403)
    expect(
      (await handleMemorySourceRequest(
        makeSourceRequest(["propose"], "wrong-key"),
        dependencies
      )).status
    ).toBe(400)
    expect(requests).toHaveLength(0)
  })
})
