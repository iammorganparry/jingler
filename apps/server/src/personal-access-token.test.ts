import {
  MEMORY_MCP_PROTOCOL_VERSION,
  type MemoryOrganizationRole,
  memoryPrivilegesForRole
} from "@jingler/core"
import { createHash } from "node:crypto"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import type {
  JsonValue,
  MemoryClient,
  MemoryClientRequest
} from "./memory-client.js"
import { handleMemoryMcpRequest, type MemoryMcpDependencies } from "./mcp-memory.js"
import { issueMemoryGrant, verifyMemoryGrant } from "./memory-grant.js"
import {
  handleCreatePersonalAccessToken,
  handleListPersonalAccessTokens,
  handleRevokePersonalAccessToken,
  type PersonalAccessTokenManagementDependencies,
  type PersonalAccessTokenManagementStore,
  type PersonalAccessTokenMetadata,
  type PersonalAccessTokenOwnership
} from "./personal-access-token-management.js"
import type { OrganizationAuthorization } from "./db/repositories/organization-repository.js"
import {
  createPersonalAccessToken,
  hashPersonalAccessToken,
  type PersonalAccessTokenRecord,
  type PersonalAccessTokenStore,
  verifyPersonalAccessToken
} from "./personal-access-token.js"

const grantConfig = {
  secret: "test-memory-grant-secret",
  audience: "jingler-memory-mcp",
  ttlSeconds: 300
}

const metadata = {
  "io.modelcontextprotocol/protocolVersion": MEMORY_MCP_PROTOCOL_VERSION,
  "io.modelcontextprotocol/clientInfo": { name: "test-client", version: "1.0.0" },
  "io.modelcontextprotocol/clientCapabilities": {}
}
const PERSONAL_ACCESS_TOKEN_PATTERN = /^jmem_/

const requestFor = (
  method: string,
  bearer: string,
  options: { readonly organizationId?: string; readonly params?: Record<string, unknown> } = {}
): Request => {
  const organizationId = options.organizationId ?? "org-paid"
  const params = options.params ?? {}
  const name = typeof params.name === "string" ? params.name : null
  return new Request("https://jingler.test/api/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
      "mcp-protocol-version": MEMORY_MCP_PROTOCOL_VERSION,
      "mcp-method": method,
      ...(name ? { "mcp-name": name } : {}),
      "x-jingler-organization-id": organizationId
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `${method}-1`,
      method,
      params: { ...params, _meta: metadata }
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
        return Effect.succeed({ pageId: "page-stable" })
      }
    }
  }
}

// A fake store keyed by the token's SHA-256 hash, mirroring how the MCP tests
// inject a fake MemoryClient. Never holds a plaintext token.
const storeFor = (record: PersonalAccessTokenRecord | null): PersonalAccessTokenStore => ({
  findByHash: async (hashedToken) =>
    record && hashedToken === record.hashedToken ? record : null
})

const paidAuthorize =
  (role: MemoryOrganizationRole = "owner", userId = "user-pat", organizationId = "org-paid") =>
  async (candidateUser: string, candidateOrg: string): Promise<OrganizationAuthorization | null> =>
    candidateUser === userId && candidateOrg === organizationId
      ? { organizationId, role, privileges: memoryPrivilegesForRole(role) }
      : null

// Compose the two verifiers exactly as app/api/mcp/route.ts does.
const composedDependencies = (
  client: MemoryClient<JsonValue>,
  patDeps: {
    readonly store: PersonalAccessTokenStore
    readonly authorize: (
      userId: string,
      organizationId: string
    ) => Promise<OrganizationAuthorization | null>
    readonly now?: () => Date
  },
  grantNowSeconds = 101
): MemoryMcpDependencies => ({
  verifyGrant: async (grant, organizationId) => {
    const patClaims = await verifyPersonalAccessToken(grant, organizationId, {
      store: patDeps.store,
      authorize: patDeps.authorize,
      audience: grantConfig.audience,
      ttlSeconds: grantConfig.ttlSeconds,
      now: patDeps.now
    })
    if (patClaims) return patClaims
    return verifyMemoryGrant(grant, {
      secret: grantConfig.secret,
      audience: grantConfig.audience,
      organizationId,
      nowSeconds: grantNowSeconds
    })
  },
  client,
  requestId: () => "request-stable"
})

const mint = (
  overrides: Partial<PersonalAccessTokenRecord> & { readonly role?: MemoryOrganizationRole } = {}
): { readonly token: string; readonly record: PersonalAccessTokenRecord } => {
  const created = createPersonalAccessToken(
    {
      userId: "user-pat",
      organizationId: "org-paid",
      name: "CI runner",
      role: overrides.role ?? "member"
    },
    { id: () => "pat-1", secret: () => "deterministic-secret-value-for-tests" }
  )
  return {
    token: created.token,
    record: { ...created.record, ...overrides }
  }
}

describe("personal access token minting", () => {
  it("returns a jmem_ plaintext once and persists only its SHA-256 hash", () => {
    const created = createPersonalAccessToken(
      { userId: "user-pat", organizationId: "org-paid", name: "laptop", role: "member" },
      { id: () => "pat-x" }
    )
    expect(created.token.startsWith("jmem_")).toBe(true)
    // ≥32 random bytes → base64url is comfortably longer than 40 chars.
    expect(created.token.length).toBeGreaterThan(40)
    expect(created.record.hashedToken).toBe(
      createHash("sha256").update(created.token).digest("hex")
    )
    // The persisted record must never carry the plaintext token.
    expect(JSON.stringify(created.record)).not.toContain(created.token)
    expect(created.record.revokedAt).toBeNull()
    expect(created.record.lastUsedAt).toBeNull()
  })

  it("verifies a non-jmem bearer as null so a grant falls through", async () => {
    const claims = await verifyPersonalAccessToken("not-a-pat.header.sig", "org-paid", {
      store: storeFor(null),
      authorize: paidAuthorize(),
      audience: grantConfig.audience,
      ttlSeconds: grantConfig.ttlSeconds
    })
    expect(claims).toBeNull()
  })
})

describe("personal access token MCP auth", () => {
  it("authorizes a tools/call for a valid PAT with the intersected privileges", async () => {
    const { token, record } = mint({ role: "member" })
    const { client, requests } = collectingClient()
    const response = await handleMemoryMcpRequest(
      requestFor("tools/call", token, {
        params: { name: "memory_search", arguments: { query: "launch", limit: 10 } }
      }),
      composedDependencies(client, { store: storeFor(record), authorize: paidAuthorize("member") })
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      result: { structuredContent: { data: { pageId: "page-stable" } } }
    })
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      organizationId: "org-paid",
      path: "/internal/memory/search?q=launch&limit=10"
    })
  })

  it("hides tools the intersected role cannot use (member has no review)", async () => {
    // Token minted as owner, but the LIVE membership is only a member → the
    // intersection strips review/schema back to member privileges.
    const { token, record } = mint({ role: "owner" })
    const { client } = collectingClient()
    const response = await handleMemoryMcpRequest(
      requestFor("tools/list", token),
      composedDependencies(client, { store: storeFor(record), authorize: paidAuthorize("member") })
    )
    const body = await response.json()
    const names = body.result.tools.map((tool: { name: string }) => tool.name)
    expect(names).toContain("memory_search")
    expect(names).not.toContain("memory_review")
    expect(names).not.toContain("memory_schema_publish")
  })

  it("rejects a revoked PAT", async () => {
    const { token, record } = mint({ revokedAt: new Date("2020-01-01T00:00:00Z") })
    const { client, requests } = collectingClient()
    const response = await handleMemoryMcpRequest(
      requestFor("tools/call", token, {
        params: { name: "memory_search", arguments: { query: "x" } }
      }),
      composedDependencies(client, { store: storeFor(record), authorize: paidAuthorize() })
    )
    expect(response.status).toBe(401)
    expect(requests).toHaveLength(0)
  })

  it("rejects an expired PAT", async () => {
    const { token, record } = mint({ expiresAt: new Date("2020-01-01T00:00:00Z") })
    const { client } = collectingClient()
    const response = await handleMemoryMcpRequest(
      requestFor("tools/list", token),
      composedDependencies(client, {
        store: storeFor(record),
        authorize: paidAuthorize(),
        now: () => new Date("2030-01-01T00:00:00Z")
      })
    )
    expect(response.status).toBe(401)
  })

  it("rejects a PAT whose membership is no longer an active paid member", async () => {
    const { token, record } = mint()
    const { client } = collectingClient()
    const response = await handleMemoryMcpRequest(
      requestFor("tools/list", token),
      // authorize returns null → the paid gate/membership check fails closed.
      composedDependencies(client, { store: storeFor(record), authorize: async () => null })
    )
    expect(response.status).toBe(401)
  })

  it("rejects a PAT scoped to a different organization than the request", async () => {
    const { token, record } = mint()
    const { client } = collectingClient()
    const response = await handleMemoryMcpRequest(
      requestFor("tools/list", token, { organizationId: "org-other" }),
      composedDependencies(client, {
        store: storeFor(record),
        authorize: paidAuthorize("member", "user-pat", "org-other")
      })
    )
    expect(response.status).toBe(401)
  })

  it("rejects a jmem_-prefixed garbage token that hashes to no stored record", async () => {
    const { client, requests } = collectingClient()
    const response = await handleMemoryMcpRequest(
      requestFor("tools/list", "jmem_this-token-was-never-issued"),
      composedDependencies(client, { store: storeFor(null), authorize: paidAuthorize() })
    )
    expect(response.status).toBe(401)
    expect(requests).toHaveLength(0)
  })

  it("still authorizes a normal HMAC grant (no regression)", async () => {
    const grant = issueMemoryGrant(
      { subject: "user-1", organizationId: "org-paid", privileges: ["read", "propose"] },
      grantConfig,
      100,
      "grant-regression"
    ).grant
    const { client, requests } = collectingClient()
    const response = await handleMemoryMcpRequest(
      requestFor("tools/call", grant, {
        params: { name: "memory_search", arguments: { query: "launch" } }
      }),
      // The PAT store is present but never consulted for a non-jmem bearer.
      composedDependencies(client, { store: storeFor(null), authorize: paidAuthorize() })
    )
    expect(response.status).toBe(200)
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ organizationId: "org-paid" })
  })

  it("never lets a stored hash reveal the plaintext token", () => {
    const { token, record } = mint()
    expect(record.hashedToken).toBe(hashPersonalAccessToken(token))
    expect(record.hashedToken).not.toContain(token)
  })
})

const managementDependencies = (overrides: {
  readonly userId?: string | null
  readonly authorization?: OrganizationAuthorization | null
  readonly store?: PersonalAccessTokenManagementStore
  readonly now?: Date
} = {}): PersonalAccessTokenManagementDependencies => ({
  getUserId: async () => overrides.userId === undefined ? "user-pat" : overrides.userId,
  authorize: async () => overrides.authorization === undefined
    ? {
        organizationId: "org-paid",
        role: "admin",
        privileges: memoryPrivilegesForRole("admin")
      }
    : overrides.authorization,
  store: overrides.store ?? {
    create: async () => {},
    listByUser: async () => [],
    findById: async () => null,
    revoke: async () => {}
  },
  now: () => overrides.now ?? new Date("2030-01-01T00:00:00.000Z")
})

describe("personal access token management", () => {
  it("creates a role-bounded token and persists only hash-only metadata", async () => {
    let persisted: Parameters<PersonalAccessTokenManagementStore["create"]>[0] | null = null
    const response = await handleCreatePersonalAccessToken(
      new Request("https://jingler.test/api/memory/tokens", {
        method: "POST",
        body: JSON.stringify({
          organizationId: "org-paid",
          name: "  CI runner  ",
          role: "member",
          expiresAt: "2030-02-01T00:00:00.000Z"
        })
      }),
      managementDependencies({
        store: {
          create: async (record) => { persisted = record },
          listByUser: async () => [],
          findById: async () => null,
          revoke: async () => {}
        }
      })
    )

    expect(response.status).toBe(201)
    expect(response.headers.get("cache-control")).toBe("no-store")
    const body = await response.json()
    expect(body).toMatchObject({
      organizationId: "org-paid",
      name: "CI runner",
      role: "member",
      expiresAt: "2030-02-01T00:00:00.000Z"
    })
    expect(body.token).toMatch(PERSONAL_ACCESS_TOKEN_PATTERN)
    expect(persisted).toMatchObject({
      userId: "user-pat",
      organizationId: "org-paid",
      name: "CI runner",
      role: "member"
    })
    expect(JSON.stringify(persisted)).not.toContain(body.token)
  })

})

describe("personal access token management validation", () => {
  it("rejects role escalation, blank names, past expiry, and unpaid membership", async () => {
    const requests = [
      { organizationId: "org-paid", name: "token", role: "owner" },
      { organizationId: "org-paid", name: "   " },
      { organizationId: "org-paid", name: "token", expiresAt: "2029-12-31T23:59:59Z" }
    ]
    const responses = await Promise.all(requests.map((body) =>
      handleCreatePersonalAccessToken(
        new Request("https://jingler.test/api/memory/tokens", {
          method: "POST",
          body: JSON.stringify(body)
        }),
        managementDependencies()
      )))
    expect(responses.map(({ status }) => status)).toEqual([403, 400, 400])

    const unpaid = await handleCreatePersonalAccessToken(
      new Request("https://jingler.test/api/memory/tokens", {
        method: "POST",
        body: JSON.stringify({ organizationId: "org-free", name: "token" })
      }),
      managementDependencies({ authorization: null })
    )
    expect(unpaid.status).toBe(403)
  })

})

describe("personal access token management listing", () => {
  it("lists only safe metadata returned by the caller-scoped store", async () => {
    const metadata: PersonalAccessTokenMetadata = {
      id: "pat-1",
      userId: "user-pat",
      organizationId: "org-paid",
      name: "Laptop",
      role: "member",
      createdAt: "2030-01-01T00:00:00.000Z",
      expiresAt: null,
      revokedAt: null,
      lastUsedAt: null
    }
    let listScope: { readonly userId: string; readonly organizationId?: string } | null = null
    const response = await handleListPersonalAccessTokens(
      new Request("https://jingler.test/api/memory/tokens?organizationId=org-paid"),
      managementDependencies({
        store: {
          create: async () => {},
          listByUser: async (userId, organizationId) => {
            listScope = { userId, organizationId }
            return [metadata]
          },
          findById: async () => null,
          revoke: async () => {}
        }
      })
    )

    expect(response.status).toBe(200)
    expect(listScope).toEqual({ userId: "user-pat", organizationId: "org-paid" })
    const body = await response.json()
    expect(body).toEqual({ tokens: [metadata] })
    expect(JSON.stringify(body)).not.toContain("hashedToken")
    expect(JSON.stringify(body)).not.toContain("jmem_")
  })

})

describe("personal access token management revocation", () => {
  it("revokes only caller-owned tokens and is idempotent", async () => {
    let revoked = 0
    let ownership: PersonalAccessTokenOwnership | null = {
      id: "pat-1",
      userId: "other-user",
      revokedAt: null
    }
    const store: PersonalAccessTokenManagementStore = {
      create: async () => {},
      listByUser: async () => [],
      findById: async () => ownership,
      revoke: async () => { revoked += 1 }
    }

    const foreign = await handleRevokePersonalAccessToken(
      new Request("https://jingler.test/api/memory/tokens/pat-1", { method: "DELETE" }),
      "pat-1",
      managementDependencies({ store })
    )
    expect(foreign.status).toBe(404)
    expect(revoked).toBe(0)

    ownership = { id: "pat-1", userId: "user-pat", revokedAt: null }
    const owned = await handleRevokePersonalAccessToken(
      new Request("https://jingler.test/api/memory/tokens/pat-1", { method: "DELETE" }),
      "pat-1",
      managementDependencies({ store })
    )
    expect(owned.status).toBe(200)
    expect(revoked).toBe(1)

    ownership = { id: "pat-1", userId: "user-pat", revokedAt: "2030-01-01T00:00:00Z" }
    const repeated = await handleRevokePersonalAccessToken(
      new Request("https://jingler.test/api/memory/tokens/pat-1", { method: "DELETE" }),
      "pat-1",
      managementDependencies({ store })
    )
    expect(repeated.status).toBe(200)
    expect(revoked).toBe(1)
  })
})
