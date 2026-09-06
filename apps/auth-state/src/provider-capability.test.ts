import { describe, expect, it } from "vitest";
import { validateCapability } from "./provider-capability.js";

const codexCapability = (accountId: string) => ({
  subject: "user_1",
  provider: "codex",
  authorizationHeader: "Bearer provider-secret",
  expiresAt: 2_000,
  upstream: "chatgpt-codex",
  accountId,
  proxy: "codex",
  connectionId: "connection_codex",
  providerId: "openai-codex",
  authKind: "openai-codex-oauth",
  billingRoute: "subscription",
});

describe("provider capability validation", () => {
  it("accepts a bounded opaque ChatGPT account identifier", () => {
    expect(
      validateCapability(codexCapability("account-current_2026"), 1_000),
    ).toMatchObject({
      ok: true,
      value: { accountId: "account-current_2026" },
    });
  });

  it.each([
    ["exa", "exa-api", "X-Api-Key exa-secret"],
    ["firecrawl", "firecrawl-api", "Bearer firecrawl-secret"],
  ])("accepts a scoped %s search capability", (provider, upstream, authorizationHeader) => {
    expect(validateCapability({
      subject: "user_1",
      provider,
      upstream,
      authorizationHeader,
      expiresAt: 2_000,
    }, 1_000)).toMatchObject({
      ok: true,
      value: { provider, upstream, accountId: null }
    })
  })

  it("rejects a search provider paired with another upstream", () => {
    expect(validateCapability({
      subject: "user_1",
      provider: "exa",
      upstream: "firecrawl-api",
      authorizationHeader: "X-Api-Key exa-secret",
      expiresAt: 2_000,
    }, 1_000)).toEqual({ ok: false, error: "Invalid capability" })
  })

  it.each(["", "x".repeat(257)])(
    "rejects an invalid ChatGPT account identifier",
    (accountId) => {
      expect(validateCapability(codexCapability(accountId), 1_000)).toEqual({
        ok: false,
        error: "Invalid capability",
      });
    },
  );

  it.each([
    { authorizationHeader: "Bearer " },
    { authorizationHeader: "Bearer secret\ninjected" },
    { authorizationHeader: `Bearer ${"x".repeat(16_384)}` },
    { unexpectedCredential: "must-not-be-ignored" },
  ])("rejects malformed or excess capability input", (override) => {
    expect(
      validateCapability(
        { ...codexCapability("account-current_2026"), ...override },
        1_000,
      ),
    ).toEqual({ ok: false, error: "Invalid capability" });
  });
});

describe("Codex upstream defaults", () => {
  it.each([undefined, "openai-api"])("defaults %s to the API upstream", (upstream) => {
    expect(validateCapability({
      subject: "user_1", provider: "codex", upstream,
      authorizationHeader: "Bearer api-secret", expiresAt: 2_000,
      proxy: "codex", connectionId: "connection_api", providerId: "openai",
      authKind: "api-key", billingRoute: "api"
    }, 1_000)).toMatchObject({ ok: true, value: { upstream: "openai-api" } })
  })

  it.each(["github-api", "anthropic-api", "exa-api", "firecrawl-api"])(
    "rejects the unrelated %s upstream for a Codex subscription",
    (upstream) => {
      expect(validateCapability({ ...codexCapability("account-1"), upstream }, 1_000))
        .toEqual({ ok: false, error: "Invalid capability" })
    }
  )
})
