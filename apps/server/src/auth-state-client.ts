import type { AuthKind, ManagedProviderProxy } from "@jingler/core";

export interface AuthStateClientConfig {
  readonly enabled: boolean;
  readonly url: string;
  readonly serviceSecret: string;
  readonly fetch?: typeof fetch;
}

interface AuthSessionState {
  readonly id: string;
  readonly userId: string;
  readonly expiresAt: Date;
}

export type AuthCapabilityProvider =
  | "github"
  | "codex"
  | "claude"
  | "exa"
  | "firecrawl";
export type AuthCapabilityUpstream =
  | "github-api"
  | "openai-api"
  | "chatgpt-codex"
  | "anthropic-api"
  | "exa-api"
  | "firecrawl-api";

interface AuthCapabilityState {
  readonly userId: string;
  readonly provider: AuthCapabilityProvider;
  readonly proxy?: ManagedProviderProxy;
  readonly authorizationHeader: string;
  readonly expiresAt: Date;
  readonly upstream?: AuthCapabilityUpstream;
  readonly accountId?: string;
  readonly connectionId?: string;
  readonly providerId?: string;
  readonly authKind?: AuthKind;
  readonly billingRoute?: "subscription" | "api";
}

const endpoint = (config: AuthStateClientConfig, userId: string): string =>
  new URL(
    `/v1/internal/users/${encodeURIComponent(userId)}/session`,
    config.url,
  ).toString();

const send = async (
  config: AuthStateClientConfig,
  input: AuthSessionState,
  method: "PUT" | "DELETE",
): Promise<void> => {
  if (!config.enabled) return;
  const response = await (config.fetch ?? fetch)(
    endpoint(config, input.userId),
    {
      method,
      headers: {
        "content-type": "application/json",
        "x-jingler-service-secret": config.serviceSecret,
      },
      body: JSON.stringify({
        sessionId: input.id,
        expiresAt: Math.floor(input.expiresAt.getTime() / 1_000),
      }),
    },
  );
  if (!response.ok) {
    throw new Error(`Auth-state session sync failed (${response.status})`);
  }
};

export const upsertAuthStateSession = (
  config: AuthStateClientConfig,
  input: AuthSessionState,
): Promise<void> => send(config, input, "PUT");

export const deleteAuthStateSession = (
  config: AuthStateClientConfig,
  input: AuthSessionState,
): Promise<void> => send(config, input, "DELETE");

const capabilityEndpoint = (
  config: AuthStateClientConfig,
  userId: string,
): string =>
  new URL(
    `/v1/internal/users/${encodeURIComponent(userId)}/capability`,
    config.url,
  ).toString();

export const upsertAuthStateCapability = async (
  config: AuthStateClientConfig,
  input: AuthCapabilityState,
): Promise<void> => {
  if (!config.enabled) return;
  const response = await (config.fetch ?? fetch)(
    capabilityEndpoint(config, input.userId),
    {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-jingler-service-secret": config.serviceSecret,
      },
      body: JSON.stringify({
        provider: input.provider,
        ...(input.proxy === undefined ? {} : { proxy: input.proxy }),
        authorizationHeader: input.authorizationHeader,
        expiresAt: Math.floor(input.expiresAt.getTime() / 1_000),
        ...(input.upstream === undefined ? {} : { upstream: input.upstream }),
        ...(input.accountId === undefined
          ? {}
          : { accountId: input.accountId }),
        ...(input.connectionId === undefined
          ? {}
          : { connectionId: input.connectionId }),
        ...(input.providerId === undefined
          ? {}
          : { providerId: input.providerId }),
        ...(input.authKind === undefined ? {} : { authKind: input.authKind }),
        ...(input.billingRoute === undefined
          ? {}
          : { billingRoute: input.billingRoute }),
      }),
    },
  );
  if (!response.ok) {
    throw new Error(`Auth-state capability sync failed (${response.status})`);
  }
};

export const deleteAuthStateCapability = async (
  config: AuthStateClientConfig,
  input: { readonly userId: string; readonly provider: AuthCapabilityProvider },
): Promise<void> => {
  if (!config.enabled) return;
  const response = await (config.fetch ?? fetch)(
    capabilityEndpoint(config, input.userId),
    {
      method: "DELETE",
      headers: {
        "content-type": "application/json",
        "x-jingler-service-secret": config.serviceSecret,
      },
      body: JSON.stringify({ provider: input.provider }),
    },
  );
  if (!response.ok) {
    throw new Error(`Auth-state capability sync failed (${response.status})`);
  }
};
