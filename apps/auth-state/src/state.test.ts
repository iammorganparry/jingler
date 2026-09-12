import { ProviderConnectionId, ProviderId } from "@jingler/core";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  emptyAuthState,
  removeExpired,
  resolveCredential,
  snapshotOf,
  type AuthStateRecord,
} from "./state.js";

const connectionId = Schema.decodeUnknownSync(ProviderConnectionId);
const providerId = Schema.decodeUnknownSync(ProviderId);

const state = (now: number): AuthStateRecord => ({
  ...emptyAuthState("user_1"),
  sessions: { session_1: { id: "session_1", expiresAt: now + 600 } },
  credentials: {
    codex: {
      provider: "codex",
      handle: "capability_opaque",
      fingerprint: "fingerprint_opaque",
      authorizationHeaderEncrypted: "v1.encrypted-secret",
      upstream: "chatgpt-codex",
      accountIdEncrypted: "v1.encrypted-account",
      providerConnection: {
        proxy: "codex",
        connectionId: connectionId("connection_one"),
        providerId: providerId("openai-codex"),
        authKind: "openai-codex-oauth",
        billingRoute: "subscription",
      },
      expiresAt: now + 300,
    },
  },
});

describe("auth state", () => {
  it("migrates legacy provider keys to connection-scoped storage", () => {
    const migrated = removeExpired(state(1_000), 1_000);
    expect(Object.keys(migrated.credentials)).toEqual([
      "codex:connection_one",
    ]);
    expect(migrated.version).toBe(2);
  });

  it("exposes only an opaque capability while the account session is active", () => {
    const snapshot = snapshotOf(state(1_000), 1_000);
    expect(snapshot.capabilities).toEqual(["managed.session.execute"]);
    expect(snapshot.credentialCapabilities).toEqual([
      { provider: "codex", handle: "capability_opaque", expiresAt: 1_300 },
    ]);
    expect(snapshot.providerConnections).toEqual([
      {
        version: 1,
        proxy: "codex",
        connectionId: "connection_one",
        providerId: "openai-codex",
        authKind: "openai-codex-oauth",
        billingRoute: "subscription",
        handle: "capability_opaque",
        expiresAt: 1_300,
      },
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("encrypted-secret");
  });

  it("fails closed after account session expiry", () => {
    const expired = removeExpired(state(1_000), 2_000);
    expect(snapshotOf(expired, 2_000).capabilities).toEqual([]);
    expect(
      resolveCredential(expired, "codex", "capability_opaque", 2_000),
    ).toBeNull();
  });

  it("rejects stale or mismatched capability handles", () => {
    expect(resolveCredential(state(1_000), "codex", "wrong", 1_000)).toBeNull();
    expect(
      resolveCredential(state(1_000), "github", "capability_opaque", 1_000),
    ).toBeNull();
  });
});

describe("provider connection isolation", () => {
  it("keeps concurrent connections for the same provider isolated", () => {
    const first = state(1_000).credentials.codex;
    if (first === undefined) throw new Error("Codex fixture is missing");
    const providerConnection = first.providerConnection;
    if (providerConnection === undefined) {
      throw new Error("Codex connection fixture is missing");
    }
    const second = {
      ...first,
      handle: "capability_second",
      fingerprint: "fingerprint_second",
      providerConnection: {
        ...providerConnection,
        connectionId: connectionId("connection_two"),
      },
    };
    const concurrent: AuthStateRecord = {
      ...state(1_000),
      credentials: {
        "codex:connection_one": first,
        "codex:connection_two": second,
      },
    };

    expect(snapshotOf(concurrent, 1_000).providerConnections).toEqual([
      expect.objectContaining({
        connectionId: "connection_one",
        handle: "capability_opaque",
      }),
      expect.objectContaining({
        connectionId: "connection_two",
        handle: "capability_second",
      }),
    ]);
    expect(
      resolveCredential(concurrent, "codex", "capability_opaque", 1_000),
    ).toBe(first);
    expect(
      resolveCredential(concurrent, "codex", "capability_second", 1_000),
    ).toBe(second);
  });
});

describe("subscription capabilities", () => {
  it("excludes legacy Claude subscription credentials from managed execution", () => {
    const now = 1_000;
    const claude: AuthStateRecord = {
      ...emptyAuthState("user_1"),
      sessions: { session_1: { id: "session_1", expiresAt: now + 600 } },
      credentials: {
        claude: {
          provider: "claude",
          handle: "capability_claude",
          fingerprint: "fingerprint_claude",
          authorizationHeaderEncrypted: "v1.encrypted-secret",
          upstream: "anthropic-api",
          providerConnection: {
            proxy: "claude",
            connectionId: connectionId("connection_claude"),
            providerId: providerId("anthropic"),
            authKind: "claude-setup-token",
            billingRoute: "subscription",
          },
          expiresAt: now + 300,
        },
      },
    };
    expect(snapshotOf(claude, now)).toMatchObject({
      capabilities: [],
      credentialCapabilities: [],
      providerConnections: [],
    });
    expect(resolveCredential(claude, "claude", "capability_claude", now))
      .toBeNull();
  });
});
