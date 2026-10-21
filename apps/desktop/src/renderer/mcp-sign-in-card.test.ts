import { describe, expect, it } from "vitest"
import { mcpSignInPhase } from "./mcp-sign-in-card.js"

describe("mcpSignInPhase", () => {
  it("walks needs sign-in -> waiting -> connected", () => {
    expect(mcpSignInPhase("needs-auth", undefined)).toBe("needs-sign-in")
    expect(mcpSignInPhase("needs-auth", "waiting")).toBe("waiting")
    expect(mcpSignInPhase("authorizing", undefined)).toBe("waiting")
    expect(mcpSignInPhase("ready", "waiting")).toBe("connected")
  })
  it("cancel returns to needs sign-in, even while the server reports authorizing", () => {
    expect(mcpSignInPhase("authorizing", "cancelled")).toBe("needs-sign-in")
  })
  it("failure shows retry; healthy servers with no attempt stay hidden", () => {
    expect(mcpSignInPhase("needs-auth", "failed")).toBe("failed")
    expect(mcpSignInPhase("ready", undefined)).toBe("hidden")
    expect(mcpSignInPhase("not-required", undefined)).toBe("hidden")
  })
})
