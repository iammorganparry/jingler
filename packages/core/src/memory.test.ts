import { Either, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  allocateMemoryRollout,
  MEMORY_ROLLOUT_POLICY_DEFAULT,
  MEMORY_MCP_PROTOCOL_VERSION,
  MemoryGrantClaims,
  MemoryCompilerWorkflowResult,
  MemoryWorkflowStatusResponse,
  MemoryFunnelTransition,
  MemoryMcpRequest,
  memoryPrivilegesForRole,
} from "./memory.js";

describe("team-memory contracts", () => {
  it("keeps role privileges explicit and monotonic", () => {
    expect(memoryPrivilegesForRole("member")).toStrictEqual([
      "read",
      "propose",
    ]);
    expect(memoryPrivilegesForRole("admin")).toStrictEqual([
      "read",
      "propose",
      "review",
    ]);
    expect(memoryPrivilegesForRole("owner")).toStrictEqual([
      "read",
      "propose",
      "review",
      "schema",
    ]);
  });

  it("allocates rollout arms stably by organization and session and disables them at zero", () => {
    const policy = {
      ...MEMORY_ROLLOUT_POLICY_DEFAULT,
      revision: "rollout-test",
      reflectionBasisPoints: 10_000,
      extractionBasisPoints: 10_000,
      autoPublicationBasisPoints: 10_000,
      relationshipBasisPoints: 10_000,
    };
    const first = allocateMemoryRollout({
      organizationId: "org-one",
      sessionId: "session-one",
      harness: "claude",
      policy,
    });
    const replay = allocateMemoryRollout({
      organizationId: "org-one",
      sessionId: "session-one",
      harness: "claude",
      policy,
    });
    const otherOrganization = allocateMemoryRollout({
      organizationId: "org-two",
      sessionId: "session-one",
      harness: "claude",
      policy,
    });
    const disabled = allocateMemoryRollout({
      organizationId: "org-one",
      sessionId: "session-one",
      policy: {
        ...policy,
        reflectionBasisPoints: 0,
        extractionBasisPoints: 0,
        autoPublicationBasisPoints: 0,
        relationshipBasisPoints: 0,
      },
    });

    expect(replay).toStrictEqual(first);
    expect(otherOrganization.allocationId).not.toBe(first.allocationId);
    expect(first.arms).toStrictEqual([
      "reflection",
      "extraction_review",
      "auto_publication",
      "relationship_review",
    ]);
    expect(disabled.arms).toStrictEqual(["control"]);
  });

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
      grantId: "grant-1",
    };
    const decoded = Schema.decodeUnknownSync(MemoryGrantClaims)(claims);

    expect(Schema.encodeSync(MemoryGrantClaims)(decoded)).toStrictEqual(claims);
    expect(Object.keys(decoded)).not.toContain("token");
  });

  it("requires the stateless protocol metadata on every request", () => {
    const request = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion":
            MEMORY_MCP_PROTOCOL_VERSION,
          "io.modelcontextprotocol/clientInfo": {
            name: "test-client",
            version: "1",
          },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    };

    expect(
      Either.isRight(Schema.decodeUnknownEither(MemoryMcpRequest)(request)),
    ).toBe(true);
    expect(
      Either.isLeft(
        Schema.decodeUnknownEither(MemoryMcpRequest)({
          ...request,
          params: { _meta: {} },
        }),
      ),
    ).toBe(true);
  });

  it("decodes successful no-learning and permanent compiler outcomes", () => {
    expect(
      Schema.decodeUnknownSync(MemoryCompilerWorkflowResult)({
        workflowId: "compiler-one",
        sourceId: "source-one",
        status: "no_durable_learning",
        reason: "no_bounded_claims",
      }).status,
    ).toBe("no_durable_learning");
    expect(
      Schema.decodeUnknownSync(MemoryWorkflowStatusResponse)({
        workflowId: "compiler-two",
        state: "complete",
        result: {
          workflowId: "compiler-two",
          sourceId: "source-two",
          status: "permanent_failure",
          code: "lint_validation",
          issueCodes: ["citation.missing"],
        },
      }).result,
    ).toMatchObject({ status: "permanent_failure" });
  });

  it("keeps funnel transitions content-free and joinable", () => {
    const transition = Schema.decodeUnknownSync(MemoryFunnelTransition)({
      id: "funnel-one",
      occurredAt: "2026-08-06T12:00:00.000Z",
      stage: "publication",
      outcome: "published",
      sourceId: "source-one",
      sourceKind: "conversation",
      workflowId: "compiler-one",
      proposalSetId: "proposal:compiler-one",
      publicationIds: ["revision-one"],
    });
    expect(transition).not.toHaveProperty("content");
    expect(transition).toMatchObject({
      sourceId: "source-one",
      workflowId: "compiler-one",
    });
  });
});
