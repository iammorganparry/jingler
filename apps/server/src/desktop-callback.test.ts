import { describe, expect, it } from "vitest"
import { isLoopbackRedirect } from "./app.js"

describe("isLoopbackRedirect", () => {
  it("accepts http loopback targets the desktop dev listener uses", () => {
    for (const url of [
      "http://127.0.0.1:5599/callback",
      "http://localhost:8080/callback?state=abc",
      "http://[::1]:3000/callback"
    ]) {
      expect(isLoopbackRedirect(url)).toBe(true)
    }
  })

  it("rejects anything that could exfiltrate a token (open-redirect guard)", () => {
    for (const url of [
      "https://127.0.0.1/callback", // not http
      "http://evil.com/callback", // remote host
      "http://169.254.169.254/callback", // link-local metadata endpoint
      "http://127.0.0.1.evil.com/callback", // suffix trick
      "jingler://auth/callback", // the deep link itself is not a "redirect"
      "not a url"
    ]) {
      expect(isLoopbackRedirect(url)).toBe(false)
    }
  })
})
