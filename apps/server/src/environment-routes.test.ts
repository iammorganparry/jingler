import type { Environment, ManagedEnvironment } from "@jingler/core";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  createEnvironmentRoutes,
  managedCloudIdForUser,
  type EnvironmentRoutesDependencies,
  type ManagedEnvironmentStore,
} from "./environment-routes.js";

const managed: ManagedEnvironment = {
  kind: "managed",
  id: managedCloudIdForUser("user_one"),
  name: "Cloud",
  platform: { os: "linux", arch: "x64" },
  capabilities: {
    version: 1,
    capabilities: ["session.start"],
    maxConcurrentSessions: 1,
  },
  state: "online",
  agentVersion: null,
  lastSeenAt: null,
  region: "wnam",
  instanceType: "basic",
  generation: 1,
  createdAt: 200,
  updatedAt: 200,
};

const owned: Environment = {
  kind: "owned",
  id: "device_one",
  name: "Build host",
  platform: { os: "darwin", arch: "arm64" },
  capabilities: {
    version: 1,
    capabilities: ["session.start"],
    maxConcurrentSessions: 1,
  },
  state: "online",
  agentVersion: "2.0.3",
  lastSeenAt: 190,
};
const managedRoute = `/api/environments/managed/${managed.id}`;
const providerSelection = {
  connectionId: "connection_one",
  providerId: "openai",
  modelId: "openai/gpt-5",
} as const;
const providerCredentialHeaders = () => ({
  "x-jingler-provider-credential": Buffer.from(
    JSON.stringify({
      version: 1,
      connectionId: providerSelection.connectionId,
      providerId: providerSelection.providerId,
      authKind: "api-key",
      access: `sk-${"a".repeat(30)}`,
      expiresAt: Date.now() + 60 * 60 * 1_000,
      accountId: null,
      billingRoute: "api",
    }),
  ).toString("base64url"),
});

const store = (): ManagedEnvironmentStore => ({
  create: vi.fn(async () => managed),
  findForUser: vi.fn(async () => managed),
  renameForUser: vi.fn(async () => managed),
  setStateForUser: vi.fn(async () => managed),
  deleteForUser: vi.fn(async () => managed),
});

const harness = (overrides: Partial<EnvironmentRoutesDependencies> = {}) => {
  const dependencies: EnvironmentRoutesDependencies = {
    enabled: true,
    now: () => new Date("2026-08-10T12:00:00.000Z"),
    getUserId: async () => "user_one",
    listOwned: async () => [{ environment: owned, createdAt: 100 }],
    store: store(),
    issueGrant: async () => ({
      version: 1,
      runtimeUrl: "https://managed-runtime.test",
      grant: "signed-runtime-grant",
      expiresAt: 300,
    }),
    ...overrides,
  };
  const app = new Hono().route(
    "/api/environments",
    createEnvironmentRoutes(() => dependencies),
  );
  return { app, dependencies };
};

describe("environment routes", () => {
  it("lists owned environments without touching managed services when disabled", async () => {
    const managedStore = store();
    const { app } = harness({
      enabled: false,
      store: managedStore,
    });

    const response = await app.request("/api/environments");

    expect(response.status).toBe(200);
    expect((await response.json()).environments).toEqual([owned]);
  });

  it("does not expose legacy harness selection on the fixed Cloud target", async () => {
    const { app } = harness();

    const response = await app.request("/api/environments");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.environments).toHaveLength(2);
    expect(body.environments[1].capabilities).not.toHaveProperty("harnesses");
  });

  it("lists owned and managed environments in stable created order", async () => {
    const { app } = harness();
    const response = await app.request("/api/environments");

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(
      body.environments.map((environment: Environment) => environment.id),
    ).toEqual(["device_one", managed.id]);
  });

  it("never returns runtime grants or provider credentials", async () => {
    const { app } = harness();
    const response = await app.request("/api/environments");
    const body = await response.text();

    expect(body).not.toMatch(
      /signed-runtime-grant|credential|providerToken|secret/,
    );
  });

  it("returns the fixed Cloud target to authenticated create clients", async () => {
    const managedStore = store();
    const { app } = harness({ store: managedStore });
    const response = await app.request("/api/environments/managed", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...providerCredentialHeaders(),
      },
      body: JSON.stringify({
        version: 1,
        name: "Cloud workspace",
        region: "wnam",
        instanceType: "basic",
        idempotencyKey: "create_workspace_one",
      }),
    });

    expect(response.status).toBe(200);
    expect((await response.json()).environment).toMatchObject({
      id: managed.id,
      name: "Cloud",
    });
    expect(managedStore.create).not.toHaveBeenCalled();
  });

  it("syncs the desktop Codex capability before managed creation", async () => {
    const syncCapabilities = vi.fn(async () => undefined);
    const { app } = harness({ syncCapabilities });
    const response = await app.request("/api/environments/managed", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...providerCredentialHeaders(),
      },
      body: JSON.stringify({
        version: 1,
        name: "Cloud workspace",
        region: "wnam",
        instanceType: "basic",
        idempotencyKey: "create_workspace_with_capability",
      }),
    });

    expect(response.status).toBe(200);
    expect(syncCapabilities).toHaveBeenCalledWith({
      userId: "user_one",
      providerCredential: {
        proxy: "codex",
        provider: "codex",
        connectionId: providerSelection.connectionId,
        providerId: providerSelection.providerId,
        authKind: "api-key",
        billingRoute: "api",
        authorizationHeader: `Bearer sk-${"a".repeat(30)}`,
        upstream: "openai-api",
        expiresAt: expect.any(Date),
      },
      includeGitHub: true,
    });
  });

  it("refuses managed creation without an explicit provider connection", async () => {
    const managedStore = store();
    const { app } = harness({
      store: managedStore,
    });
    const response = await app.request("/api/environments/managed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        name: "Cloud workspace",
        region: "wnam",
        instanceType: "basic",
        idempotencyKey: "create_workspace_without_capability",
      }),
    });

    expect(response.status).toBe(409);
    expect(managedStore.create).not.toHaveBeenCalled();
  });

  it("refuses a grant for a stale managed environment generation", async () => {
    const issueGrant = vi.fn<EnvironmentRoutesDependencies["issueGrant"]>();
    const { app } = harness({ issueGrant });
    const response = await app.request(`${managedRoute}/grants`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        sessionId: "session_one",
        usageIntervalId: "command_one",
        expectedGeneration: 2,
        ...providerSelection,
        actions: ["session.start"],
      }),
    });

    expect(response.status).toBe(409);
    expect(issueGrant).not.toHaveBeenCalled();
  });

  it("reserves and scopes one usage interval before issuing a runtime grant", async () => {
    const reserveStart = vi.fn(async () => ({
      status: "reserved" as const,
      reservationId: "usage_command_one",
    }));
    const issueGrant = vi.fn<EnvironmentRoutesDependencies["issueGrant"]>(
      async () => ({
        version: 1,
        runtimeUrl: "https://managed-runtime.test",
        grant: "signed-runtime-grant",
        expiresAt: 300,
      }),
    );
    const { app } = harness({ reserveStart, issueGrant });
    const response = await app.request(`${managedRoute}/grants`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...providerCredentialHeaders(),
      },
      body: JSON.stringify({
        version: 1,
        sessionId: "session_one",
        usageIntervalId: "command_one",
        expectedGeneration: 1,
        ...providerSelection,
        actions: ["session.start"],
      }),
    });

    expect(response.status).toBe(200);
    expect(reserveStart).toHaveBeenCalledWith({
      userId: "user_one",
      environmentId: managed.id,
      sessionId: "session_one",
      usageIntervalId: "command_one",
    });
    expect(issueGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        reservationId: "usage_command_one",
      }),
    );
  });

  it("issues cancellation grants without a second compute reservation", async () => {
    const reserveStart = vi.fn();
    const syncCapabilities = vi.fn(async () => undefined);
    const issueGrant = vi.fn<EnvironmentRoutesDependencies["issueGrant"]>(
      async () => ({
        version: 1,
        runtimeUrl: "https://managed-runtime.test",
        grant: "signed-runtime-grant",
        expiresAt: 300,
      }),
    );
    const { app } = harness({ reserveStart, issueGrant, syncCapabilities });

    const response = await app.request(`${managedRoute}/grants`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...providerCredentialHeaders(),
      },
      body: JSON.stringify({
        version: 1,
        sessionId: "session_one",
        usageIntervalId: "command_stop",
        expectedGeneration: 1,
        ...providerSelection,
        actions: ["session.cancel"],
      }),
    });

    expect(response.status).toBe(200);
    expect(reserveStart).not.toHaveBeenCalled();
    expect(syncCapabilities).not.toHaveBeenCalled();
    expect(issueGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        reservationId: null,
      }),
    );
  });

  it("destroys a failed managed session and releases its unused reservation", async () => {
    const destroySession = vi.fn(async () => undefined);
    const releaseSessionStart = vi.fn(async () => undefined);
    const { app } = harness({ destroySession, releaseSessionStart });

    const response = await app.request(
      `${managedRoute}/sessions/session_failed/delete`,
      { method: "POST" },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ version: 1, deleted: true });
    expect(destroySession).toHaveBeenCalledWith({
      userId: "user_one",
      environmentId: managed.id,
      sessionId: "session_failed",
    });
    expect(releaseSessionStart).toHaveBeenCalledWith({
      userId: "user_one",
      environmentId: managed.id,
      sessionId: "session_failed",
    });
  });

  it("does not allow the fixed Cloud target to be deleted", async () => {
    const managedStore = store();
    const destroyEnvironment = vi.fn(async () => undefined);
    const { app } = harness({ store: managedStore, destroyEnvironment });
    const response = await app.request(`${managedRoute}/delete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 1, expectedGeneration: 1 }),
    });

    expect(response.status).toBe(409);
    expect(destroyEnvironment).not.toHaveBeenCalled();
    expect(managedStore.deleteForUser).not.toHaveBeenCalled();
  });
});
