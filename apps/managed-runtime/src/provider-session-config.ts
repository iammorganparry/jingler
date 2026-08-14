import type { ManagedProviderCapability } from "@jingler/core";

export interface ManagedProviderEnvironment extends Readonly<
  Record<string, string>
> {
  readonly JINGLER_PROVIDER_CONNECTION_ID: string;
  readonly JINGLER_PROVIDER_ID: string;
  readonly JINGLER_PROVIDER_AUTH_KIND: string;
  readonly JINGLER_PROVIDER_CONFIRMED_BILLING_ROUTE: string;
  readonly JINGLER_PROVIDER_ACCESS: string;
  readonly JINGLER_PROVIDER_EXPIRES_AT: string;
  readonly JINGLER_PROVIDER_BASE_URL: string;
  readonly JINGLER_WEB_SEARCH_PROVIDER: string;
  readonly JINGLER_WEB_SEARCH_URL: string;
}

const base64Url = (value: string): string =>
  btoa(value).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");

const codexProxyToken = (nonce: string): string =>
  [
    base64Url(JSON.stringify({ alg: "none", typ: "JWT" })),
    base64Url(
      JSON.stringify({
        "https://api.openai.com/auth": {
          chatgpt_account_id: "00000000-0000-0000-0000-000000000000",
        },
      }),
    ),
    base64Url(nonce),
  ].join(".");

const proxyAccess = (
  capability: ManagedProviderCapability,
  nonce: string,
): string =>
  capability.authKind === "openai-codex-oauth"
    ? codexProxyToken(nonce)
    : capability.authKind === "claude-setup-token"
      ? `sk-ant-oat01-${nonce}`
      : `provider_${nonce}`;

export const managedProviderEnvironment = (input: {
  readonly capability: ManagedProviderCapability;
  readonly origin: string;
  readonly sessionId: string;
  readonly nonce: string;
  readonly webSearchProvider?: "exa" | "firecrawl";
}): ManagedProviderEnvironment => {
  const baseUrl = `${input.origin.replace(/\/$/u, "")}/v1/provider/${input.capability.proxy}/${encodeURIComponent(input.sessionId)}${input.capability.proxy === "codex" ? "/v1" : ""}`;
  return {
    JINGLER_PROVIDER_CONNECTION_ID: input.capability.connectionId,
    JINGLER_PROVIDER_ID: input.capability.providerId,
    JINGLER_PROVIDER_AUTH_KIND: input.capability.authKind,
    JINGLER_PROVIDER_CONFIRMED_BILLING_ROUTE: input.capability.billingRoute,
    JINGLER_PROVIDER_ACCESS: proxyAccess(input.capability, input.nonce),
    JINGLER_PROVIDER_EXPIRES_AT: String(input.capability.expiresAt * 1_000),
    JINGLER_PROVIDER_BASE_URL: baseUrl,
    JINGLER_WEB_SEARCH_PROVIDER: input.webSearchProvider ?? "",
    JINGLER_WEB_SEARCH_URL:
      input.webSearchProvider === undefined
        ? ""
        : `${input.origin.replace(/\/$/u, "")}/v1/web-search/${input.webSearchProvider}/${encodeURIComponent(input.sessionId)}`,
  };
};
