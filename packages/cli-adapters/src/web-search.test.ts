import { describe, expect, it, vi } from "vitest"
import { browserWebSearchPort, routeWebSearch } from "./web-search.js"
import { WebSearchError } from "@jingler/core"
import { searchWithProvider } from "./web-search-providers.js"

const signal = () => new AbortController().signal

describe("WebSearch target routing", () => {
  const query = { query: "research", maxResults: 5 }
  const response = (route: "exa" | "native" | "browser") => ({ route, results: [] })

  it("falls from a configured provider to native search", async () => {
    const native = vi.fn(async () => response("native"))
    const browser = vi.fn(async () => response("browser"))
    const result = await routeWebSearch({
      config: { setup: "configured", provider: "exa" },
      query,
      signal: signal(),
      resolveKey: async () => "exa-secret",
      providerSearch: async () => { throw new Error("provider down") },
      native: { search: native },
      browser: { search: browser }
    })
    expect(result.route).toBe("native")
    expect(native).toHaveBeenCalledOnce()
    expect(browser).not.toHaveBeenCalled()
  })

  it("uses browser only when explicitly contributed by the target", async () => {
    const browser = vi.fn(async () => response("browser"))
    const withBrowser = await routeWebSearch({
      config: { setup: "skipped", provider: null },
      query,
      signal: signal(),
      resolveKey: async () => null,
      browser: { search: browser }
    })
    expect(withBrowser.route).toBe("browser")

    await expect(routeWebSearch({
      config: { setup: "skipped", provider: null },
      query,
      signal: signal(),
      resolveKey: async () => null
    })).rejects.toMatchObject({ reason: "unavailable" })
  })

  it("propagates cancellation without starting native or browser fallbacks", async () => {
    const native = vi.fn(async () => response("native"))
    const browser = vi.fn(async () => response("browser"))
    await expect(routeWebSearch({
      config: { setup: "configured", provider: "exa" },
      query,
      signal: signal(),
      resolveKey: async () => "exa-secret",
      providerSearch: async () => {
        throw new WebSearchError({
          reason: "cancelled",
          message: "cancelled",
          retryable: true
        })
      },
      native: { search: native },
      browser: { search: browser }
    })).rejects.toMatchObject({ reason: "cancelled" })
    expect(native).not.toHaveBeenCalled()
    expect(browser).not.toHaveBeenCalled()
  })

  it("stops browser extraction when cancellation interrupts navigation", async () => {
    const controller = new AbortController()
    let finishNavigate: (() => void) | undefined
    const navigate = vi.fn(() => new Promise<void>((resolve) => {
      finishNavigate = resolve
    }))
    const evaluate = vi.fn(async () => ({ result: "[]" }))
    const pending = browserWebSearchPort({
      navigate,
      evaluate,
      screenshot: vi.fn(),
      click: vi.fn(),
      type: vi.fn(),
      readText: vi.fn(),
      waitForSelector: vi.fn()
    }).search(query, controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ reason: "cancelled" })
    finishNavigate?.()
    expect(evaluate).not.toHaveBeenCalled()
  })

  it("does not wait for setup when no target route exists", async () => {
    await expect(routeWebSearch({
      config: { setup: "pending", provider: null },
      query,
      signal: signal(),
      resolveKey: async () => null
    })).rejects.toMatchObject({ reason: "setup-required", retryable: false })
  })
})

describe("WebSearch provider adapters", () => {
  it("normalizes bounded EXA results with citations", async () => {
    const fetch = vi.fn(async () => Response.json({
      results: [{
        title: "Jingler",
        url: "https://example.test/result",
        text: "A cited result",
        publishedDate: "2026-01-02"
      }]
    }))
    const result = await searchWithProvider({
      provider: "exa",
      apiKey: "exa-secret",
      input: { query: "jingler", maxResults: 5 },
      signal: signal()
    }, { fetch })

    expect(result).toEqual({
      route: "exa",
      results: [{
        title: "Jingler",
        url: "https://example.test/result",
        snippet: "A cited result",
        publishedAt: "2026-01-02"
      }]
    })
    expect(fetch).toHaveBeenCalledWith(
      "https://api.exa.ai/search",
      expect.objectContaining({
        headers: expect.objectContaining({ "x-api-key": "exa-secret" })
      })
    )
  })

  it("normalizes Firecrawl and drops unsafe URLs", async () => {
    const result = await searchWithProvider({
      provider: "firecrawl",
      apiKey: "firecrawl-secret",
      input: { query: "research", maxResults: 2 },
      signal: signal()
    }, {
      fetch: async () => Response.json({ data: [
        { title: "Unsafe", url: "file:///etc/passwd", description: "no" },
        { title: "Safe", url: "https://docs.example.test", description: "yes" }
      ] })
    })
    expect(result.results).toHaveLength(1)
    expect(result.results[0]?.title).toBe("Safe")
  })

  it.each([
    [401, "authentication"],
    [429, "rate-limited"],
    [503, "provider"]
  ] as const)("maps HTTP %s to %s", async (status, reason) => {
    await expect(searchWithProvider({
      provider: "exa",
      apiKey: "exa-secret",
      input: { query: "query", maxResults: 5 },
      signal: signal()
    }, { fetch: async () => new Response("error", { status }) })).rejects.toMatchObject({ reason })
  })

  it("cancels a chunked response as soon as its streamed byte limit is exceeded", async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < 513; index += 1) {
          controller.enqueue(new Uint8Array(1_024))
        }
      },
      cancel() {
        cancelled = true
      }
    })
    await expect(searchWithProvider({
      provider: "exa",
      apiKey: "exa-secret",
      input: { query: "query", maxResults: 5 },
      signal: signal()
    }, { fetch: async () => new Response(body) })).rejects.toMatchObject({
      reason: "invalid-response"
    })
    expect(cancelled).toBe(true)
  })

  it("rejects oversized responses before decoding", async () => {
    await expect(searchWithProvider({
      provider: "firecrawl",
      apiKey: "firecrawl-secret",
      input: { query: "query", maxResults: 5 },
      signal: signal()
    }, {
      fetch: async () => new Response("{}", {
        headers: { "content-length": String(600 * 1_024) }
      })
    })).rejects.toMatchObject({ reason: "invalid-response" })
  })
})
