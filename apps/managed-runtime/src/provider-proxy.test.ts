import { describe, expect, it, vi } from "vitest"
import {
  createControlPlaneProviderFetch,
  providerAuthorizationScope,
  proxyProviderRequest
} from "./provider-proxy.js"

describe("managed provider credential proxy", () => {
  it("routes ChatGPT Codex egress through the authenticated control plane", async () => {
    const upstream = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const request = input instanceof Request ? input : new Request(input)
      expect(request.url).toBe(
        "https://api.jingler.dev/api/internal/managed-provider/codex/v1/responses"
      )
      expect(request.headers.get("x-jingler-service-secret")).toBe("service-secret")
      expect(request.headers.get("authorization")).toBe("Bearer oauth-secret")
      return Response.json({ id: "response_1" })
    })
    const providerFetch = createControlPlaneProviderFetch({
      controlPlaneUrl: "https://api.jingler.dev",
      serviceSecret: "service-secret",
      fetch: upstream
    })
    await providerFetch(
      new Request("https://chatgpt.com/backend-api/codex/v1/responses", {
        headers: { authorization: "Bearer oauth-secret" }
      })
    )
    expect(upstream).toHaveBeenCalledOnce()
  })

  it("accepts provider authorization without unrelated git metadata", () => {
    expect(
      providerAuthorizationScope({
        subject: "user-1",
        capabilityHandle: "capability_codex_1"
      })
    ).toEqual({
      subject: "user-1",
      capabilityHandle: "capability_codex_1"
    })
    expect(providerAuthorizationScope({ subject: "user-1" })).toBeNull()
    expect(
      providerAuthorizationScope({
        subject: "user-1",
        capabilityHandle: "capability_codex_1",
        unexpected: true
      })
    ).toBeNull()
    expect(
      providerAuthorizationScope({
        subject: "user-1",
        capabilityHandle: "x".repeat(257)
      })
    ).toBeNull()
  })

  it("keeps real GitHub credentials inside the Worker-side upstream request", async () => {
    const providerToken = "ghp_provider_secret_value"
    const upstream = vi.fn(async function (
      this: typeof globalThis,
      input: Parameters<typeof fetch>[0]
    ) {
      expect(this).toBe(globalThis)
      const request = input instanceof Request ? input : new Request(input)
      expect(request.headers.get("authorization")).toBe(
        `Basic ${btoa(`x-access-token:${providerToken}`)}`
      )
      return new Response("pack-data", {
        headers: { "content-type": "application/x-git-upload-pack-result" }
      })
    })
    const response = await proxyProviderRequest(
      {
        subject: "user_1",
        provider: "github",
        gitSmartHttp: true,
        capabilityHandle: "capability_github_1",
        upstreamUrl: "https://github.com/jingler/example.git/info/refs",
        method: "GET"
      },
      {
        resolve: async () => ({
          authorizationHeader: `Bearer ${providerToken}`
        }),
        fetch: upstream
      }
    )
    expect(await response.text()).toBe("pack-data")
    expect(JSON.stringify([...response.headers])).not.toContain(providerToken)
  })

  it("rejects arbitrary destinations before resolving credentials", async () => {
    const resolve = vi.fn(async () => ({
      authorizationHeader: "Bearer secret"
    }))
    const response = await proxyProviderRequest(
      {
        subject: "user_1",
        capabilityHandle: "capability_github_1",
        upstreamUrl: "https://attacker.example/collect",
        method: "GET"
      },
      { resolve, fetch }
    )
    expect(response.status).toBe(400)
    expect(resolve).not.toHaveBeenCalled()
  })

  it("keeps real Codex credentials inside the Worker-side upstream request", async () => {
    const providerToken = "sk-provider-secret-value"
    const upstream = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const request = input instanceof Request ? input : new Request(input)
      expect(request.url).toBe("https://api.openai.com/v1/responses")
      expect(request.headers.get("authorization")).toBe(`Bearer ${providerToken}`)
      expect(request.headers.get("user-agent")).toBe("codex_cli_rs/0.147.0")
      expect(request.headers.get("originator")).toBe("codex_cli_rs")
      expect(request.headers.get("openai-beta")).toBe("responses=experimental")
      return Response.json({ id: "response_1" })
    })
    const response = await proxyProviderRequest(
      {
        provider: "codex",
        subject: "user_1",
        capabilityHandle: "capability_codex_1",
        upstreamUrl: "https://api.openai.com/v1/responses",
        method: "POST",
        userAgent: "codex_cli_rs/0.147.0",
        originator: "codex_cli_rs",
        openAiBeta: "responses=experimental",
        contentType: "application/json",
        body: new Response(JSON.stringify({ model: "gpt-5" })).body
      },
      {
        resolve: async () => ({
          authorizationHeader: `Bearer ${providerToken}`
        }),
        fetch: upstream
      }
    )
    expect(await response.json()).toEqual({ id: "response_1" })
  })

  it("maps ChatGPT subscription Codex requests and scopes them to the account", async () => {
    const upstream = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const request = input instanceof Request ? input : new Request(input)
      expect(request.url).toBe("https://chatgpt.com/backend-api/codex/responses")
      expect(request.headers.get("chatgpt-account-id")).toBe("account_1")
      expect(request.headers.get("authorization")).toBe("Bearer oauth-secret")
      return Response.json({ id: "response_1" })
    })
    const response = await proxyProviderRequest(
      {
        provider: "codex",
        subject: "user_1",
        capabilityHandle: "capability_codex_1",
        upstreamUrl: "https://api.openai.com/v1/responses",
        method: "POST"
      },
      {
        resolve: async () => ({
          authorizationHeader: "Bearer oauth-secret",
          upstream: "chatgpt-codex",
          accountId: "account_1"
        }),
        fetch: upstream
      }
    )
    expect(response.status).toBe(200)
  })

  it("normalizes the pi-ai Codex response path without duplicating the service prefix", async () => {
    const upstream = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const request = input instanceof Request ? input : new Request(input)
      expect(request.url).toBe("https://chatgpt.com/backend-api/codex/responses")
      expect(request.headers.get("content-encoding")).toBe("zstd")
      expect(request.headers.get("session-id")).toBe("session_1")
      expect(request.headers.get("x-client-request-id")).toBe("request_1")
      return Response.json({ id: "response_1" })
    })
    const response = await proxyProviderRequest(
      {
        provider: "codex",
        subject: "user_1",
        capabilityHandle: "capability_codex_1",
        upstreamUrl: "https://api.openai.com/v1/codex/responses",
        method: "POST",
        contentEncoding: "zstd",
        sessionId: "session_1",
        clientRequestId: "request_1"
      },
      {
        resolve: async () => ({
          authorizationHeader: "Bearer oauth-secret",
          upstream: "chatgpt-codex",
          accountId: "account_1"
        }),
        fetch: upstream
      }
    )

    expect(response.ok).toBe(true)
    expect(upstream).toHaveBeenCalledOnce()
  })

  it("proxies Claude subscription auth without exposing it to the sandbox", async () => {
    const upstream = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const request = input instanceof Request ? input : new Request(input)
      expect(request.url).toBe("https://api.anthropic.com/v1/messages")
      expect(request.headers.get("authorization")).toBe("Bearer claude-oauth-secret")
      expect(request.headers.get("anthropic-version")).toBe("2023-06-01")
      return Response.json({ id: "message_1" })
    })
    const response = await proxyProviderRequest(
      {
        provider: "claude",
        subject: "user_1",
        capabilityHandle: "capability_claude_1",
        upstreamUrl: "https://api.anthropic.com/v1/messages",
        method: "POST"
      },
      {
        resolve: async () => ({
          authorizationHeader: "Bearer claude-oauth-secret",
          upstream: "anthropic-api"
        }),
        fetch: upstream
      }
    )
    expect(response.status).toBe(200)
  })

  it("never exposes provider secrets in sandbox commands, files, URLs, events, logs, or checkpoints", async () => {
    const providerToken = "ghp_provider_secret_value"
    const visible: string[] = []
    const response = await proxyProviderRequest(
      {
        subject: "user_1",
        capabilityHandle: "capability_github_1",
        upstreamUrl: "https://api.github.com/repos/jingler/example",
        method: "GET"
      },
      {
        resolve: async () => ({
          authorizationHeader: `Bearer ${providerToken}`
        }),
        fetch: async (input) => {
          const request = input instanceof Request ? input : new Request(input)
          visible.push(request.url.replace("api.github.com", "provider"))
          return Response.json({ ok: true })
        }
      }
    )
    visible.push(await response.text())
    expect(visible.join("\n")).not.toContain(providerToken)
  })

  it("rejects provider transfers beyond the configured egress limit", async () => {
    const response = await proxyProviderRequest(
      {
        subject: "user_1",
        capabilityHandle: "capability_github_1",
        upstreamUrl: "https://github.com/jingler/example.git/git-upload-pack",
        method: "POST",
        contentLength: 11
      },
      {
        resolve: async () => ({ authorizationHeader: "Bearer test" }),
        fetch,
        maxEgressBytes: 10
      }
    )
    expect(response.status).toBe(413)
  })

  it("falls back to the bounded default when the configured limit is invalid", async () => {
    const response = await proxyProviderRequest(
      {
        subject: "user_1",
        capabilityHandle: "capability_github_1",
        upstreamUrl: "https://github.com/jingler/example.git/git-upload-pack",
        method: "POST",
        contentLength: 100 * 1024 * 1024 + 1
      },
      {
        resolve: async () => ({ authorizationHeader: "Bearer test" }),
        fetch,
        maxEgressBytes: Number.NaN
      }
    )
    expect(response.status).toBe(413)
  })

  it("stops chunked request bodies at the configured transfer limit", async () => {
    const upstream = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const request = input instanceof Request ? input : new Request(input)
      await request.arrayBuffer()
      return new Response("unexpected")
    })
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(6))
        controller.enqueue(new Uint8Array(6))
        controller.close()
      }
    })

    await expect(
      proxyProviderRequest(
        {
          subject: "user_1",
          capabilityHandle: "capability_github_1",
          upstreamUrl: "https://github.com/jingler/example.git/git-upload-pack",
          method: "POST",
          body
        },
        {
          resolve: async () => ({ authorizationHeader: "Bearer test" }),
          fetch: upstream,
          maxEgressBytes: 10
        }
      )
    ).rejects.toThrow("exceeded its egress limit")
    expect(upstream).toHaveBeenCalledOnce()
  })
})
