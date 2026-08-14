import { Effect, Layer } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import { AgentSecretStore } from "./runtime/auth/agent-secret-store.js"
import { makeInMemorySecretStore, SecretStore } from "./secret-store.js"
import { WebSearchCredentialService } from "./web-search-credentials.js"

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

afterEach(() => vi.unstubAllGlobals())

describe("WebSearch credential storage", () => {
  it("keeps provider keys in independent encrypted-document slots", async () => {
    const secretStore = await run(makeInMemorySecretStore())
    const credentials = new AgentSecretStore(secretStore)

    await run(credentials.writeWebSearch("exa", {
      apiKey: "exa-secret-key",
      validatedAt: null,
      cloudSynced: false
    }))
    await run(credentials.writeWebSearch("firecrawl", {
      apiKey: "firecrawl-secret-key",
      validatedAt: "2026-01-01T00:00:00.000Z",
      cloudSynced: true
    }))

    expect(await run(credentials.readWebSearch("exa"))).toEqual({
      apiKey: "exa-secret-key",
      validatedAt: null,
      cloudSynced: false
    })
    expect(await run(credentials.readWebSearch("firecrawl"))).toEqual({
      apiKey: "firecrawl-secret-key",
      validatedAt: "2026-01-01T00:00:00.000Z",
      cloudSynced: true
    })

    await run(credentials.deleteWebSearch("exa"))
    expect(await run(credentials.readWebSearch("exa"))).toBeNull()
    expect(await run(credentials.readWebSearch("firecrawl"))).not.toBeNull()
  })

  it("keeps a cloud-synced key when revocation cannot be confirmed", async () => {
    const secretStore = await run(makeInMemorySecretStore("desktop-bearer"))
    const credentials = new AgentSecretStore(secretStore)
    await run(credentials.writeWebSearch("exa", {
      apiKey: "exa-cloud-secret",
      validatedAt: null,
      cloudSynced: true
    }))
    const request = vi.fn(async () => new Response("unavailable", { status: 503 }))
    vi.stubGlobal("fetch", request)

    await expect(run(WebSearchCredentialService.clear("exa").pipe(
      Effect.provide(WebSearchCredentialService.Default),
      Effect.provide(Layer.succeed(SecretStore, secretStore))
    ))).rejects.toThrow("Could not revoke the Cloud WebSearch credential")
    expect(await run(credentials.readWebSearch("exa"))).toMatchObject({
      apiKey: "exa-cloud-secret",
      cloudSynced: true
    })
    expect(request).toHaveBeenCalledWith(
      expect.stringContaining("/api/environments/web-search-credential"),
      expect.objectContaining({ method: "DELETE", signal: expect.any(AbortSignal) })
    )
  })

  it("does not replace a provider until the previous Cloud capability is revoked", async () => {
    const secretStore = await run(makeInMemorySecretStore("desktop-bearer"))
    const credentials = new AgentSecretStore(secretStore)
    await run(credentials.writeWebSearch("firecrawl", {
      apiKey: "firecrawl-cloud-secret",
      validatedAt: null,
      cloudSynced: true
    }))
    const request = vi.fn()
      .mockResolvedValueOnce(Response.json({ results: [] }))
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
    vi.stubGlobal("fetch", request)

    await expect(run(WebSearchCredentialService.set({
      provider: "exa",
      apiKey: "exa-new-secret"
    }).pipe(
      Effect.provide(WebSearchCredentialService.Default),
      Effect.provide(Layer.succeed(SecretStore, secretStore))
    ))).rejects.toThrow("Could not revoke the Cloud WebSearch credential")
    expect(await run(credentials.readWebSearch("exa"))).toBeNull()
    expect(await run(credentials.readWebSearch("firecrawl"))).toMatchObject({
      apiKey: "firecrawl-cloud-secret"
    })
  })

  it("syncs through authenticated server transport and returns redacted status", async () => {
    const secretStore = await run(makeInMemorySecretStore("desktop-bearer"))
    const request = vi.fn(async () => Response.json({ synced: true }))
    vi.stubGlobal("fetch", request)
    const effect = WebSearchCredentialService.set({
      provider: "exa",
      apiKey: "exa-cloud-secret"
    }).pipe(
      Effect.provide(WebSearchCredentialService.Default),
      Effect.provide(Layer.succeed(SecretStore, secretStore))
    )

    const status = await run(effect)
    expect(status).toEqual({
      provider: "exa",
      configured: true,
      cloudSynced: true,
      validatedAt: expect.any(String)
    })
    expect(JSON.stringify(status)).not.toContain("exa-cloud-secret")
    expect(request).toHaveBeenCalledWith(
      expect.stringContaining("/api/environments/web-search-credential"),
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({
          Authorization: "Bearer desktop-bearer"
        })
      })
    )
  })
})
