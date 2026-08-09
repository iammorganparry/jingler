import { describe, expect, it, vi } from "vitest"
import { linearApiUrl, linearGraphql } from "./graphql.js"

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  })

describe("linearGraphql", () => {
  it("uses the personal API key Authorization header", async () => {
    const request = vi.fn(async () => json({ data: { viewer: { id: "viewer-1" } } }))

    await linearGraphql({
      apiKey: "lin_api_secret",
      query: "query Viewer { viewer { id } }",
      request
    })

    expect(request).toHaveBeenCalledWith(
      "https://api.linear.app/graphql",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "lin_api_secret" })
      })
    )
  })

  it("does not expose the API key or response body in failures", async () => {
    const apiKey = "lin_api_must_not_leak"
    const responseBody = "private Linear response body"
    const request = vi.fn(async () => new Response(responseBody, { status: 500 }))

    const error = await linearGraphql({
      apiKey,
      query: "query SecretOperation { viewer { id } }",
      request
    })
      .then(() => "resolved")
      .catch((reason: unknown) => String(reason))

    expect(error).not.toContain(apiKey)
    expect(error).not.toContain(responseBody)
    expect(error).not.toContain("SecretOperation")
  })

  it("rejects GraphQL errors returned with HTTP 200", async () => {
    const request = vi.fn(async () =>
      json({ data: { issue: null }, errors: [{ message: "not allowed" }] })
    )

    await expect(
      linearGraphql({ apiKey: "lin_api_test", query: "query Issue { issue { id } }", request })
    )
      .rejects.toThrow("Linear rejected the request")
  })
})

describe("linearGraphql status errors", () => {
  it("maps authentication and rate-limit failures to actionable messages", async () => {
    const unauthenticated = vi.fn(async () => new Response("not JSON", { status: 401 }))
    const forbidden = vi.fn(async () => new Response(null, { status: 403 }))
    const statusRateLimited = vi.fn(async () => new Response("not JSON", { status: 429 }))
    const rateLimited = vi.fn(async () =>
      json({ errors: [{ extensions: { code: "RATELIMITED" } }] }, 400)
    )

    await expect(
      linearGraphql({ apiKey: "bad", query: "query Viewer { viewer { id } }", request: unauthenticated })
    )
      .rejects.toThrow("Replace it in Settings")
    await expect(
      linearGraphql({ apiKey: "bad", query: "query Viewer { viewer { id } }", request: forbidden })
    )
      .rejects.toThrow("Replace it in Settings")
    await expect(
      linearGraphql({ apiKey: "key", query: "query Viewer { viewer { id } }", request: statusRateLimited })
    )
      .rejects.toThrow("rate limit")
    await expect(
      linearGraphql({ apiKey: "key", query: "query Viewer { viewer { id } }", request: rateLimited })
    )
      .rejects.toThrow("rate limit")
  })
})

describe("linearApiUrl", () => {
  it("allows HTTPS endpoints and HTTP only on loopback", () => {
    expect(linearApiUrl(undefined)).toBe("https://api.linear.app/graphql")
    expect(linearApiUrl("https://linear-proxy.example/graphql")).toBe(
      "https://linear-proxy.example/graphql"
    )
    expect(linearApiUrl("http://127.0.0.1:43123/graphql")).toBe(
      "http://127.0.0.1:43123/graphql"
    )
    expect(linearApiUrl("http://localhost:43123/graphql")).toBe(
      "http://localhost:43123/graphql"
    )
    expect(linearApiUrl("http://[::1]:43123/graphql")).toBe(
      "http://[::1]:43123/graphql"
    )
    expect(() => linearApiUrl("http://linear-proxy.example/graphql")).toThrow(
      "must use HTTPS unless it targets loopback"
    )
    expect(() => linearApiUrl("file:///tmp/graphql")).toThrow("HTTP or HTTPS")
  })

  it("validates explicit request endpoints before sending the API key", async () => {
    const request = vi.fn(async () => json({ data: { viewer: { id: "viewer-1" } } }))

    await expect(
      linearGraphql({
        apiKey: "lin_api_secret",
        query: "query Viewer { viewer { id } }",
        endpoint: "http://linear-proxy.example/graphql",
        request
      })
    )
      .rejects.toThrow("must use HTTPS unless it targets loopback")
    expect(request).not.toHaveBeenCalled()
  })
})
