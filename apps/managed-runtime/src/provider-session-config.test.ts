import { ManagedProviderCapability } from "@jingler/core";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { managedProviderEnvironment } from "./provider-session-config.js";

const capability = (
  input: Partial<Schema.Schema.Encoded<typeof ManagedProviderCapability>> = {},
) =>
  Schema.decodeUnknownSync(ManagedProviderCapability)({
    version: 1,
    proxy: "codex",
    connectionId: "connection_one",
    providerId: "openai-codex",
    authKind: "openai-codex-oauth",
    billingRoute: "subscription",
    handle: "capability_one",
    expiresAt: 1_800_000_000,
    ...input,
  });

describe("managed provider session environment", () => {
  it("pins Codex OAuth to the selected connection and proxy URL", () => {
    const environment = managedProviderEnvironment({
      capability: capability(),
      origin: "https://runtime.example/",
      sessionId: "session/one",
      nonce: "nonce",
    });

    const payload = JSON.parse(
      Buffer.from(
        environment.JINGLER_PROVIDER_ACCESS!.split(".")[1]!,
        "base64url",
      ).toString("utf8"),
    );
    expect(environment).toMatchObject({
      JINGLER_PROVIDER_CONNECTION_ID: "connection_one",
      JINGLER_PROVIDER_ID: "openai-codex",
      JINGLER_PROVIDER_AUTH_KIND: "openai-codex-oauth",
      JINGLER_PROVIDER_CONFIRMED_BILLING_ROUTE: "subscription",
      JINGLER_PROVIDER_BASE_URL:
        "https://runtime.example/v1/provider/codex/session%2Fone/v1",
    });
    expect(payload).toEqual({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "00000000-0000-0000-0000-000000000000",
      },
    });
    expect(environment).not.toHaveProperty("OPENAI_API_KEY");
  });

  it("provides only a scoped search proxy route when configured", () => {
    const environment = managedProviderEnvironment({
      capability: capability(),
      origin: "https://runtime.example/",
      sessionId: "session/one",
      nonce: "nonce",
      webSearchProvider: "exa"
    })
    expect(environment.JINGLER_WEB_SEARCH_PROVIDER).toBe("exa")
    expect(environment.JINGLER_WEB_SEARCH_URL).toBe(
      "https://runtime.example/v1/web-search/exa/session%2Fone"
    )
    expect(JSON.stringify(environment)).not.toContain("capability_search")
  })

  it("gives Claude setup-token auth the token shape pi requires", () => {
    const environment = managedProviderEnvironment({
      capability: capability({
        proxy: "claude",
        providerId: "anthropic",
        authKind: "claude-setup-token",
      }),
      origin: "https://runtime.example",
      sessionId: "session_one",
      nonce: "nonce",
    });

    expect(environment.JINGLER_PROVIDER_ACCESS).toBe("sk-ant-oat01-nonce");
    expect(environment.JINGLER_PROVIDER_BASE_URL).toBe(
      "https://runtime.example/v1/provider/claude/session_one",
    );
    expect(environment).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
  });
});
