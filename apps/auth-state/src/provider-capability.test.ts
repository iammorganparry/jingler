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
