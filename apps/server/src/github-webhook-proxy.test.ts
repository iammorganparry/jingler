import { describe, expect, it, vi } from "vitest"
import { proxyGitHubWebhook } from "./github-webhook-proxy.js"

describe("proxyGitHubWebhook", () => {
  it("forwards the raw signed delivery to the relay without leaking unrelated headers", async () => {
    const payload = new Uint8Array([0, 1, 2, 127, 128, 255])
    const signature = ["sha256", "fixture"].join("=")
    const fetcher = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const forwarded = new Request(input, init)
      expect(forwarded.url).toBe("https://github-relay.jingler.dev/webhooks/github")
      expect(new Uint8Array(await forwarded.arrayBuffer())).toEqual(payload)
      expect(forwarded.headers.get("x-hub-signature-256")).toBe(signature)
      expect(forwarded.headers.get("x-github-delivery")).toBe("delivery-1")
      expect(forwarded.headers.get("x-github-event")).toBe("ping")
      expect(forwarded.headers.has("authorization")).toBe(false)
      return new Response("accepted", { status: 202 })
    })
    const request = new Request("https://api.jingler.dev/webhooks/github", {
      method: "POST",
      headers: {
        authorization: "must-not-forward",
        "content-type": "application/json",
        "x-github-delivery": "delivery-1",
        "x-github-event": "ping",
        "x-hub-signature-256": signature
      },
      body: payload
    })

    const response = await proxyGitHubWebhook(
      request,
      "https://github-relay.jingler.dev/base/path",
      fetcher
    )

    expect(response.status).toBe(202)
    expect(await response.text()).toBe("accepted")
    expect(fetcher).toHaveBeenCalledOnce()
  })
})
