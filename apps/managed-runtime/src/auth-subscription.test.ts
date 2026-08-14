import { ManagedProviderCapability, ProviderConnectionId } from "@jingler/core";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  hasSameProviderRoute,
  ManagedAuthSubscriptionLedger,
  type ManagedAuthSnapshot,
} from "./auth-subscription.js";

const providerConnection = Schema.decodeUnknownSync(ManagedProviderCapability)({
  version: 1,
  proxy: "codex",
  connectionId: "connection_one",
  providerId: "openai-codex",
  authKind: "openai-codex-oauth",
  billingRoute: "subscription",
  handle: "capability_one",
  expiresAt: 500,
});

const snapshot = (version = 1): ManagedAuthSnapshot => ({
  subject: "user_123",
  version,
  issuedAt: 100,
  expiresAt: 500,
  capabilities: ["managed.session.execute"],
  credentialCapabilities: [],
  providerConnections: [providerConnection],
});

describe("managed auth lifecycle", () => {
  it("shares one auth-state subscription across active session sandboxes", () => {
    const ledger = new ManagedAuthSubscriptionLedger("user_123");
    expect(ledger.registerSession("session_1", 100)).toEqual({
      subscribe: true,
    });
    ledger.apply(snapshot(), { leaseExpiresAt: 400 });
    expect(ledger.registerSession("session_1", 101)).toEqual({
      subscribe: false,
    });
    expect(ledger.snapshot().activeSessionIds).toEqual(["session_1"]);
  });

  it("rejects commands while auth-state subscription stale", () => {
    const ledger = new ManagedAuthSubscriptionLedger("user_123");
    ledger.registerSession("session_1", 100);
    ledger.apply(snapshot(), { leaseExpiresAt: 110 });
    expect(ledger.authorize("managed.session.execute", 111)).toEqual({
      admitted: false,
      reason: "auth-stale",
    });
  });
});

describe("managed provider connection routing", () => {
  it("resolves only the exact active provider connection", () => {
    const ledger = new ManagedAuthSubscriptionLedger("user_123");
    ledger.registerSession("session_1", 100);
    ledger.apply(snapshot(), { leaseExpiresAt: 400 });

    expect(
      ledger.providerConnection(providerConnection.connectionId, 101),
    ).toMatchObject({
      providerId: "openai-codex",
      handle: "capability_one",
    });
    expect(
      ledger.providerConnection(
        Schema.decodeUnknownSync(ProviderConnectionId)("connection_other"),
        101,
      ),
    ).toBeNull();
  });

  it("treats authentication and billing changes as a different route", () => {
    expect(
      hasSameProviderRoute(providerConnection, {
        ...providerConnection,
        authKind: "api-key",
        billingRoute: "api",
      }),
    ).toBe(false);
    expect(
      hasSameProviderRoute(providerConnection, {
        ...providerConnection,
        handle: "capability_rotated",
        expiresAt: 600,
      }),
    ).toBe(true);
  });
});

describe("managed auth recovery", () => {
  it("reacquires versioned snapshot after hibernation", () => {
    const original = new ManagedAuthSubscriptionLedger("user_123");
    original.registerSession("session_1", 100);
    original.apply(snapshot(), { leaseExpiresAt: 110 });

    const restored = new ManagedAuthSubscriptionLedger(
      "user_123",
      original.snapshot(),
    );
    expect(restored.needsSubscription(111)).toBe(true);
    expect(restored.apply(snapshot(2), { leaseExpiresAt: 600 })).toBe(true);
    expect(restored.authorize("managed.session.execute", 112)).toEqual({
      admitted: true,
      authStateVersion: 2,
    });
  });

  it("releases the per-user slot when a lifecycle interval settles", () => {
    const ledger = new ManagedAuthSubscriptionLedger("user_123");
    ledger.registerSession("session_1", 100);
    ledger.apply(snapshot(), { leaseExpiresAt: 400 });
    ledger.unregisterSession("session_1");

    expect(ledger.registerSession("session_2", 101)).toEqual({
      subscribe: false,
    });
    expect(ledger.snapshot().activeSessionIds).toEqual(["session_2"]);
  });

  it("reclaims an abandoned session slot after its bounded lease", () => {
    const ledger = new ManagedAuthSubscriptionLedger("user_123");
    ledger.registerSession("session_abandoned", 100);
    ledger.apply(
      { ...snapshot(), expiresAt: 20_000 },
      { leaseExpiresAt: 10_000 },
    );

    expect(() => ledger.registerSession("session_blocked", 101)).toThrow(
      "Managed session concurrency exceeded",
    );
    expect(ledger.registerSession("session_recovered", 7_301)).toEqual({
      subscribe: false,
    });
    expect(ledger.snapshot().activeSessionIds).toEqual(["session_recovered"]);
  });
});
