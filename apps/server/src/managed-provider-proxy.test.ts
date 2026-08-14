import { describe, expect, it, vi } from "vitest"
import { proxyManagedCodexRequest } from "./managed-provider-proxy.js"

const secret = "managed-runtime-service-secret-at-least-32-bytes"

describe("managed Codex control-plane proxy", () => {
  it("forwards an authenticated request only to the fixed ChatGPT Codex origin", async () => {
    const upstream = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      expect(String(input)).toBe("https://chatgpt.com/backend-api/codex/v1/responses")
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer oauth-secret")
      expect(new Headers(init?.headers).get("user-agent")).toBe("codex_cli_rs/0.147.0")
      expect(new Headers(init?.headers).get("content-encoding")).toBe("zstd")
      expect(new Headers(init?.headers).get("session-id")).toBe("session_1")
      return Response.json({ id: "response_1" })
    })
    const response = await proxyManagedCodexRequest(
      new Request("https://api.jingler.dev/internal", {
        method: "POST",
        headers: {
          authorization: "Bearer oauth-secret",
          "content-type": "application/json",
          "content-encoding": "zstd",
          "session-id": "session_1",
          "user-agent": "codex_cli_rs/0.147.0",
          "x-jingler-service-secret": secret
        },
        body: "{}"
      }),
      "/v1/responses",
      { serviceSecret: secret, maxEgressBytes: 1_024, fetch: upstream }
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ id: "response_1" })
  })

  it("rejects unauthenticated, traversing, and oversized requests", async () => {
    const dependencies = { serviceSecret: secret, maxEgressBytes: 1 }
    expect((await proxyManagedCodexRequest(
      new Request("https://api.jingler.dev/internal"),
      "/v1/responses",
      dependencies
    )).status).toBe(401)
    expect((await proxyManagedCodexRequest(
      new Request("https://api.jingler.dev/internal", {
        headers: {
          authorization: "Bearer token",
          "x-jingler-service-secret": secret
        }
      }),
      "/../collect",
      dependencies
    )).status).toBe(400)
    expect((await proxyManagedCodexRequest(
      new Request("https://api.jingler.dev/internal", {
        method: "POST",
        headers: {
          authorization: "Bearer token",
          "content-length": "2",
          "x-jingler-service-secret": secret
        },
        body: "{}"
      }),
      "/v1/responses",
      dependencies
    )).status).toBe(413)
  })
})
