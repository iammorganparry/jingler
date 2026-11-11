import { describe, expect, it } from "vitest"
import { mcpOAuthStartError } from "./mcp-oauth-flow.js"

describe("mcpOAuthStartError", () => {
  it("turns the SDK's DCR refusal into a next step and passes other errors through", () => {
    const dcr = mcpOAuthStartError("Slack", new Error("Incompatible auth server: does not support dynamic client registration"))
    expect(dcr.message).toContain("Connect it on claude.ai")
    const other = new Error("fetch failed")
    expect(mcpOAuthStartError("Slack", other)).toBe(other)
  })
})
