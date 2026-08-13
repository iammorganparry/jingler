import { SecretStore } from "@jingler/cli-adapters/secret-store";
import { AgentSecretStore } from "@jingler/cli-adapters/runtime/auth/agent-secret-store";
import { ProviderConnections } from "@jingler/cli-adapters/runtime/providers/provider-connections";
import { withTempRoot } from "@jingler/cli-adapters/test-support";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Effect, Either } from "effect";
import { describe, expect, it } from "vitest";
import { makeDeviceProviderLayers } from "./provider-runtime.js";

describe("device provider runtime", () => {
  it("keeps subscription and API environment routes as separate connections", () => {
    const layers = makeDeviceProviderLayers("device-1", {
      JINGLER_CLAUDE_SETUP_TOKEN: "sk-ant-oat-test-token",
      ANTHROPIC_API_KEY: "anthropic-api-key",
    });

    expect(
      layers.connections.map(({ id, authKind }) => ({ id, authKind })),
    ).toEqual([
      { id: "device-1:claude-subscription", authKind: "claude-setup-token" },
      { id: "device-1:anthropic-environment", authKind: "device-environment" },
    ]);
  });

  it("resolves only the credential pinned to the selected connection", async () => {
    const layers = makeDeviceProviderLayers("device-1", {
      JINGLER_CLAUDE_SETUP_TOKEN: "sk-ant-oat-subscription-token",
      ANTHROPIC_API_KEY: "unrelated-api-key",
    });
    const credentials = await Effect.runPromise(
      Effect.gen(function* () {
        const secrets = yield* SecretStore;
        const store = new AgentSecretStore(secrets);
        return yield* Effect.all([
          store.read(layers.connections[0]!.id),
          store.read(layers.connections[1]!.id),
        ]);
      }).pipe(Effect.provide(layers.SecretStoreLive)),
    );

    expect(credentials[0]).toMatchObject({
      authKind: "claude-setup-token",
      access: "sk-ant-oat-subscription-token",
    });
    expect(credentials[1]).toMatchObject({
      authKind: "device-environment",
      access: "unrelated-api-key",
    });
  });
});

describe("managed provider proxy", () => {
  it("registers the managed proxy on the exact pi provider", () => {
    const layers = makeDeviceProviderLayers("managed_cloud_1", {
      JINGLER_PROVIDER_CONNECTION_ID: "connection-1",
      JINGLER_PROVIDER_ID: "openai-codex",
      JINGLER_PROVIDER_AUTH_KIND: "openai-codex-oauth",
      JINGLER_PROVIDER_ACCESS: "managed-provider-access-token",
      JINGLER_PROVIDER_EXPIRES_AT: "1786473600000",
      JINGLER_PROVIDER_BASE_URL:
        "https://runtime.example/v1/provider/codex/session-1/v1/",
    });
    const calls: unknown[] = [];
    layers.configureModelRuntime({
      registerProvider: (...args: unknown[]) => calls.push(args),
    } as unknown as ModelRuntime);

    expect(calls).toEqual([
      [
        "openai-codex",
        {
          baseUrl: "https://runtime.example/v1/provider/codex/session-1/v1",
        },
      ],
    ]);
    expect(layers.connections[0]?.targetId).toBe("managed_cloud_1");
  });

  it("rejects an explicit provider connection without a proxy URL", () => {
    expect(() =>
      makeDeviceProviderLayers("device-1", {
        JINGLER_PROVIDER_CONNECTION_ID: "connection-1",
        JINGLER_PROVIDER_ID: "anthropic",
        JINGLER_PROVIDER_AUTH_KIND: "claude-setup-token",
        JINGLER_PROVIDER_ACCESS: "managed-provider-access-token",
      }),
    ).toThrow("JINGLER_PROVIDER_BASE_URL is required");
  });
});

describe("device provider contract", () => {
  it("exposes the typed provider contract without permitting remote credential mutation", async () => {
    const temp = withTempRoot();
    const layers = makeDeviceProviderLayers("device-1", {
      JINGLER_CLAUDE_SETUP_TOKEN: "sk-ant-oat-subscription-token",
    });
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const providers = yield* ProviderConnections;
        const status = yield* providers.status;
        const mutation = yield* Effect.either(
          providers.connectClaudeToken({
            id: "device-test-connection",
            token: "must-not-be-persisted-remotely",
            targetId: "device-1",
          }),
        );
        return { status, mutation };
      }).pipe(
        Effect.provide(layers.ProviderConnectionsLive),
        Effect.provide(layers.SecretStoreLive),
        Effect.provide(temp.layer),
        Effect.ensuring(Effect.sync(temp.cleanup)),
      ),
    );

    expect(result.status).toEqual(layers.connections);
    expect(Either.isLeft(result.mutation)).toBe(true);
    if (Either.isLeft(result.mutation)) {
      expect(result.mutation.left.message).toContain(
        "Configure Claude subscription credentials on the target device",
      );
    }
  });
});
