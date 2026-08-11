import { describe, expect, it } from "vitest"
import { managedCodexConfig, managedCodexHome } from "./harness-config.js"

describe("managed harness configuration", () => {
  it("routes Codex through an ephemeral user-level config outside the workspace", () => {
    expect(managedCodexHome).toBe("/tmp/jingler-codex")
    const config = managedCodexConfig(
      "https://runtime.example/v1/provider/codex/session/v1"
    )
    expect(config).toContain('model_provider = "jingler_managed"')
    expect(config).toContain(
      'base_url = "https://runtime.example/v1/provider/codex/session/v1"'
    )
    expect(config).toContain('wire_api = "responses"')
    expect(config).toContain('env_key = "OPENAI_API_KEY"')
    expect(config).toContain("supports_websockets = false")
  })
})
