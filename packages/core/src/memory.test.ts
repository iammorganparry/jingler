import { Either, Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  MEMORY_MCP_PROTOCOL_VERSION,
  MemoryGrantClaims,
  MemoryMcpRequest,
  memoryPrivilegesForRole
} from "./memory.js"

describe("team-memory contracts", () => {
  it("keeps role privileges explicit and monotonic", () => {
    expect(memoryPrivilegesForRole("member")).toStrictEqual(["read", "propose"])
    expect(memoryPrivilegesForRole("admin")).toStrictEqual(["read", "propose", "review"])
    expect(memoryPrivilegesForRole("owner")).toStrictEqual([
      "read",
      "propose",
      "review",
      "schema"
    ])
  })

  it("round-trips grant claims without any bearer-token field", () => {
    const claims = {
      version: 1,
      issuer: "jingler",
      audience: "jingler-memory-mcp",
      subject: "user-1",
      organizationId: "org-1",
      privileges: ["read", "propose"],
      issuedAt: 100,
      expiresAt: 200,
      grantId: "grant-1"
    }
    const decoded = Schema.decodeUnknownSync(MemoryGrantClaims)(claims)

    expect(Schema.encodeSync(MemoryGrantClaims)(decoded)).toStrictEqual(claims)
    expect(Object.keys(decoded)).not.toContain("token")
  })

  it("requires the stateless protocol metadata on every request", () => {
    const request = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MEMORY_MCP_PROTOCOL_VERSION,
          "io.modelcontextprotocol/clientInfo": { name: "test-client", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {}
        }
      }
    }

    expect(Either.isRight(Schema.decodeUnknownEither(MemoryMcpRequest)(request))).toBe(true)
    expect(
      Either.isLeft(
        Schema.decodeUnknownEither(MemoryMcpRequest)({
          ...request,
          params: { _meta: {} }
        })
      )
    ).toBe(true)
  })
})
