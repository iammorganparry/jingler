import { describe, expect, it, vi } from "vitest"
import { startAuthLoopback } from "./auth-loopback.js"

describe("startAuthLoopback", () => {
  it("exposes a 127.0.0.1 callback URL carrying a state nonce", async () => {
    const loopback = await startAuthLoopback(vi.fn())
    try {
      const url = new URL(loopback.url)
      expect(url.hostname).toBe("127.0.0.1")
      expect(url.pathname).toBe("/callback")
      expect(url.searchParams.get("state")).toMatch(/^[0-9a-f]{32}$/)
    } finally {
      loopback.close()
    }
  })

  it("delivers the token when the state nonce matches", async () => {
    const deliver = vi.fn()
    const loopback = await startAuthLoopback(deliver)
    try {
      const res = await fetch(`${loopback.url}&token=tok_abc`)
      expect(res.status).toBe(200)
      expect(deliver).toHaveBeenCalledWith({ token: "tok_abc", error: null })
    } finally {
      loopback.close()
    }
  })

  it("ignores a forged callback with the wrong state nonce", async () => {
    const deliver = vi.fn()
    const loopback = await startAuthLoopback(deliver)
    try {
      const base = loopback.url.split("?")[0]
      const res = await fetch(`${base}?state=forged&token=tok_evil`)
      expect(res.status).toBe(403)
      expect(deliver).not.toHaveBeenCalled()
    } finally {
      loopback.close()
    }
  })
})
