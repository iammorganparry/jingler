import { describe, expect, it, vi } from "vitest"
import { proxyProviderRequest } from "./provider-proxy.js"

describe("managed provider credential proxy", () => {
  it("keeps real GitHub credentials inside the Worker-side upstream request", async () => {
    const providerToken = "ghp_provider_secret_value"
    const upstream = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const request = input instanceof Request ? input : new Request(input)
      expect(request.headers.get("authorization")).toBe(`Bearer ${providerToken}`)
      return new Response("pack-data", {
        headers: { "content-type": "application/x-git-upload-pack-result" }
      })
    })
    const response = await proxyProviderRequest(
      {
        subject: "user_1",
        capabilityHandle: "capability_github_1",
        upstreamUrl: "https://github.com/jingler/example.git/info/refs",
        method: "GET"
      },
      {
        resolve: async () => ({ authorizationHeader: `Bearer ${providerToken}` }),
        fetch: upstream
      }
    )
    expect(await response.text()).toBe("pack-data")
    expect(JSON.stringify([...response.headers])).not.toContain(providerToken)
  })

  it("rejects arbitrary destinations before resolving credentials", async () => {
    const resolve = vi.fn(async () => ({ authorizationHeader: "Bearer secret" }))
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
      return Response.json({ id: "response_1" })
    })
    const response = await proxyProviderRequest(
      {
        provider: "codex",
        subject: "user_1",
        capabilityHandle: "capability_codex_1",
        upstreamUrl: "https://api.openai.com/v1/responses",
        method: "POST",
        contentType: "application/json",
        body: new Response(JSON.stringify({ model: "gpt-5" })).body
      },
      {
        resolve: async () => ({ authorizationHeader: `Bearer ${providerToken}` }),
        fetch: upstream
      }
    )
    expect(await response.json()).toEqual({ id: "response_1" })
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
        resolve: async () => ({ authorizationHeader: `Bearer ${providerToken}` }),
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
})
