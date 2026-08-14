import { ManagedProviderCapability } from "@jingler/core";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { decodeManagedGrantRequest } from "./grant-request.js";
import {
  ManagedRuntimeConfiguration,
  runtimeConfigurationForRegistration,
} from "./runtime-configuration.js";

describe("runtimeConfigurationForRegistration", () => {
  it("maps a grant registration to the exact managed-session schema", () => {
    const grant = decodeManagedGrantRequest({
      version: 1,
      actions: ["session.observe"],
      subject: "user_one",
      environmentId: "managed_one",
      environmentGeneration: 3,
      sessionId: "session_one",
      reservationId: null,
      connectionId: "connection_one",
      providerId: "anthropic",
      modelId: "anthropic/claude-fable-5",
    });
    expect(grant).not.toBeNull();
    if (grant === null) throw new Error("Expected valid managed grant fixture");
    const providerConnection = Schema.decodeUnknownSync(
      ManagedProviderCapability,
    )({
      version: 1,
      connectionId: "connection_one",
      providerId: "anthropic",
      authKind: "claude-setup-token",
      billingRoute: "subscription",
      proxy: "claude",
      handle: "credential_one",
      expiresAt: 2_000_000_000,
    });
    const configuration = runtimeConfigurationForRegistration(
      grant,
      {
        authStateVersion: 7,
        providerConnection,
        githubCapabilityHandle: null,
      },
    );

    expect(
      Schema.decodeUnknownSync(ManagedRuntimeConfiguration)(configuration, {
        onExcessProperty: "error",
      }),
    ).toEqual(configuration);
    expect(configuration).not.toHaveProperty("version");
    expect(configuration).not.toHaveProperty("actions");
  });
});
