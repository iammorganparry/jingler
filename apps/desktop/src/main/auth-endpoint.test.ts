import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { applyDefaultAuthUrl, PRODUCTION_AUTH_URL } from "./auth-endpoint.js"
import { AUTH_PROTOCOL } from "./deep-link.js"

describe("applyDefaultAuthUrl", () => {
  it("points a packaged build at the production backend", () => {
    // Regression: installed builds fell back to localhost:9100 and could not sign in.
    const env: NodeJS.ProcessEnv = {}
    applyDefaultAuthUrl(true, env)
    expect(env.JINGLER_AUTH_URL).toBe(PRODUCTION_AUTH_URL)
  })

  it("keeps an explicit override in a packaged build", () => {
    const env: NodeJS.ProcessEnv = { JINGLER_AUTH_URL: "http://127.0.0.1:4555" }
    applyDefaultAuthUrl(true, env)
    expect(env.JINGLER_AUTH_URL).toBe("http://127.0.0.1:4555")
  })

  it("leaves unpackaged runs to their own configuration", () => {
    const env: NodeJS.ProcessEnv = {}
    applyDefaultAuthUrl(false, env)
    expect(env.JINGLER_AUTH_URL).toBeUndefined()
  })
})

describe("packaged sign-in callback", () => {
  it("declares the jingler:// scheme so macOS routes the callback to the app", () => {
    // Regression: without CFBundleURLTypes, setAsDefaultProtocolClient is a
    // no-op in packaged builds and OAuth / magic-link sign-in never completes.
    const builderConfig = readFileSync(
      join(import.meta.dirname, "../../electron-builder.yml"),
      "utf8"
    )
    expect(builderConfig).toMatch(
      new RegExp(`^protocols:\\n(?:  .*\\n)*?    schemes:\\n      - ${AUTH_PROTOCOL}$`, "mu")
    )
  })
})
