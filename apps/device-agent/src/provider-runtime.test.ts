import { readFile, stat } from "node:fs/promises";
import { makePiCredentialStore } from "@jingler/cli-adapters";
import { makeAppPaths } from "@jingler/cli-adapters/app-paths-factory";
import { SecretStore } from "@jingler/cli-adapters/secret-store";
import { AgentSecretStore } from "@jingler/cli-adapters/runtime/auth/agent-secret-store";
import { ProviderConnections } from "@jingler/cli-adapters/runtime/providers/provider-connections";
import { withTempRoot } from "@jingler/cli-adapters/test-support";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Effect, Either } from "effect";
import { describe, expect, it } from "vitest";
import { makeDeviceProviderLayers } from "./provider-runtime.js";
import { makeDeviceSecretStoreLive } from "./device-secret-store.js";

type DeviceProviderLayers = ReturnType<typeof makeDeviceProviderLayers>;

const rotateCodexCredential = (layers: DeviceProviderLayers) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const secrets = yield* SecretStore;
      const piCredentials = makePiCredentialStore(
        layers.connections[0]!,
        new AgentSecretStore(secrets),
      );
      yield* Effect.promise(() =>
        piCredentials.modify("openai-codex", async () => ({
          type: "oauth",
          access: "rotated-access-token",
          refresh: "rotated-refresh-token",
          expires: 1_786_473_900_000,
        })),
      );
    }).pipe(Effect.provide(layers.SecretStoreLive)),
  );

const readFirstCredential = (layers: DeviceProviderLayers) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const secrets = yield* SecretStore;
      return yield* new AgentSecretStore(secrets).read(layers.connections[0]!.id);
    }).pipe(Effect.provide(layers.SecretStoreLive)),
  );

describe("device provider runtime", () => {
  it("keeps subscription and API environment routes as separate connections", () => {
    const layers = makeDeviceProviderLayers("device-1", {
      JINGLER_CLAUDE_SETUP_TOKEN: "sk-ant-oat-test-token",
      JINGLER_CODEX_OAUTH_ACCESS: "codex-oauth-token",
      ANTHROPIC_API_KEY: "anthropic-api-key",
    });

    expect(
      layers.connections.map(({ id, authKind }) => ({ id, authKind })),
    ).toEqual([
      { id: "device-1:claude-subscription", authKind: "claude-setup-token" },
      {
        id: "device-1:codex-subscription",
        authKind: "openai-codex-oauth",
      },
      { id: "device-1:anthropic-environment", authKind: "device-environment" },
    ]);
    expect(layers.connections.slice(0, 2)).toMatchObject([
      {
        status: "entitlement-unconfirmed",
        subscription: { confirmedBillingRoute: null },
      },
      {
        status: "entitlement-unconfirmed",
        subscription: { confirmedBillingRoute: null },
      },
    ]);
    expect(layers.connections[2]).toMatchObject({
      status: "authenticated",
      subscription: { confirmedBillingRoute: "device-environment" },
    });
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

describe("owned device credential persistence", () => {
  it("restores a rotated Codex refresh token from the encrypted device vault", async () => {
    const temp = withTempRoot();
    const paths = makeAppPaths(temp.root);
    const environment = {
      JINGLER_CODEX_OAUTH_ACCESS: "original-access-token",
      JINGLER_CODEX_OAUTH_REFRESH: "original-refresh-token",
      JINGLER_CODEX_OAUTH_EXPIRES_AT: "1786473600000",
    };
    const persistentStore = (initialDeviceSecrets: string) =>
      makeDeviceSecretStoreLive(
        paths.deviceIdentityFile,
        paths.deviceSecretsFile,
        initialDeviceSecrets,
      );
    try {
      const first = makeDeviceProviderLayers(
        "device-1",
        environment,
        undefined,
        persistentStore,
      );
      await rotateCodexCredential(first);

      const restarted = makeDeviceProviderLayers(
        "device-1",
        environment,
        undefined,
        persistentStore,
      );
      const credential = await readFirstCredential(restarted);

      expect(credential).toMatchObject({
        access: "rotated-access-token",
        refresh: "rotated-refresh-token",
        expiresAt: 1_786_473_900_000,
      });
      const encrypted = await readFile(paths.deviceSecretsFile);
      expect(encrypted.toString("utf8")).not.toContain("rotated-refresh-token");
      expect((await stat(paths.deviceSecretsFile)).mode & 0o777).toBe(0o600);
    } finally {
      temp.cleanup();
    }
  });
});

describe("managed provider proxy", () => {
  it("keeps proxy credentials out of the owned-device vault", () => {
    let vaultOpened = false;
    makeDeviceProviderLayers(
      "managed_cloud_1",
      {
        JINGLER_PROVIDER_CONNECTION_ID: "connection-1",
        JINGLER_PROVIDER_ID: "openai-codex",
        JINGLER_PROVIDER_AUTH_KIND: "openai-codex-oauth",
        JINGLER_PROVIDER_ACCESS: "managed-provider-access-token",
        JINGLER_PROVIDER_BASE_URL: "https://runtime.example/provider/codex",
      },
      undefined,
      () => {
        vaultOpened = true;
        throw new Error("managed proxy attempted durable persistence");
      },
    );

    expect(vaultOpened).toBe(false);
  });

  it("registers the managed proxy on the exact pi provider", () => {
    const layers = makeDeviceProviderLayers("managed_cloud_1", {
      JINGLER_PROVIDER_CONNECTION_ID: "connection-1",
      JINGLER_PROVIDER_ID: "openai-codex",
      JINGLER_PROVIDER_AUTH_KIND: "openai-codex-oauth",
      JINGLER_PROVIDER_CONFIRMED_BILLING_ROUTE: "subscription",
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
    expect(layers.connections[0]).toMatchObject({
      status: "authenticated",
      subscription: {
        entitlement: "active",
        confirmedBillingRoute: "subscription",
      },
    });
  });

  it("keeps an explicit subscription credential unconfirmed without route evidence", () => {
    const layers = makeDeviceProviderLayers("device-1", {
      JINGLER_PROVIDER_CONNECTION_ID: "connection-1",
      JINGLER_PROVIDER_ID: "anthropic",
      JINGLER_PROVIDER_AUTH_KIND: "claude-setup-token",
      JINGLER_PROVIDER_ACCESS: "managed-provider-access-token",
      JINGLER_PROVIDER_BASE_URL: "https://runtime.example/provider/claude",
    });

    expect(layers.connections[0]).toMatchObject({
      status: "entitlement-unconfirmed",
      subscription: {
        entitlement: "unknown",
        confirmedBillingRoute: null,
      },
    });
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
