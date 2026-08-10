import { SecretStore } from "@jingler/cli-adapters/secret-store"
import { AgentSecretStore } from "@jingler/cli-adapters/runtime/auth/agent-secret-store"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { makeDeviceProviderLayers } from "./provider-runtime.js"

describe("device provider runtime", () => {
  it("keeps subscription and API environment routes as separate connections", () => {
    const layers = makeDeviceProviderLayers("device-1", {
      JINGLER_CLAUDE_SETUP_TOKEN: "sk-ant-oat-test-token",
      ANTHROPIC_API_KEY: "anthropic-api-key"
    })

    expect(layers.connections.map(({ id, authKind }) => ({ id, authKind }))).toEqual([
      { id: "device-1:claude-subscription", authKind: "claude-setup-token" },
      { id: "device-1:anthropic-environment", authKind: "device-environment" }
    ])
  })

  it("resolves only the credential pinned to the selected connection", async () => {
    const layers = makeDeviceProviderLayers("device-1", {
      JINGLER_CLAUDE_SETUP_TOKEN: "sk-ant-oat-subscription-token",
      ANTHROPIC_API_KEY: "unrelated-api-key"
    })
    const credentials = await Effect.runPromise(
      Effect.gen(function* () {
        const secrets = yield* SecretStore
        const store = new AgentSecretStore(secrets)
        return yield* Effect.all([
          store.read(layers.connections[0]!.id),
          store.read(layers.connections[1]!.id)
        ])
      }).pipe(Effect.provide(layers.SecretStoreLive))
    )

    expect(credentials[0]).toMatchObject({
      authKind: "claude-setup-token",
      access: "sk-ant-oat-subscription-token"
    })
    expect(credentials[1]).toMatchObject({
      authKind: "device-environment",
      access: "unrelated-api-key"
    })
  })
})
