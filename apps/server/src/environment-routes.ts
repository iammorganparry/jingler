import type {
  Environment,
  ManagedEnvironment,
  ManagedEnvironmentGrantRequest as ManagedEnvironmentGrantRequestValue,
  ManagedEnvironmentLifecycleRequest as ManagedEnvironmentLifecycleRequestValue,
  ManagedProviderCapability,
} from "@jingler/core";
import {
  CreateManagedEnvironmentRequest,
  DeleteManagedEnvironmentRequest,
  EnvironmentInventoryResponse,
  ManagedProviderCredential,
  ManagedRuntimeProviderSelection,
  ManagedEnvironmentGrantRequest,
  ManagedEnvironmentGrantResponse,
  ManagedEnvironmentLifecycleRequest,
  RenameManagedEnvironmentRequest,
  WorkspaceProvisioningPlan,
} from "@jingler/core";
import crypto from "node:crypto";
import { Either, Schema } from "effect";
import { Hono } from "hono";
import { getAuth } from "./auth.js";
import { loadAccountDevicesForUser } from "./device-routes.js";
import {
  ManagedEnvironmentRepository,
  type CreateManagedEnvironmentInput,
} from "./db/repositories/managed-environment-repository.js";
import {
  ManagedUsageRepository,
  type ManagedUsageReservationResult,
} from "./db/repositories/managed-usage-repository.js";
import { env } from "./env.js";
import {
  deleteAuthStateCapability,
  type AuthCapabilityUpstream,
  upsertAuthStateCapability,
} from "./auth-state-client.js";
import { managedGitHubCapabilityForUser } from "./github-routes.js";
import { decodeBoundedJson } from "./request-decoding.js";
import { runtime } from "./runtime.js";

const noStoreHeaders = { "cache-control": "no-store" } as const;
const MANAGED_CLOUD_IDEMPOTENCY_KEY = "account_cloud_v1";

const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status, headers: noStoreHeaders });

class ManagedRuntimeRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const runtimeError = async (
  response: Response,
  fallback: string,
): Promise<ManagedRuntimeRequestError> => {
  const body: unknown = await response.json().catch(() => null);
  return new ManagedRuntimeRequestError(
    response.status,
    typeof body === "object" &&
      body !== null &&
      "error" in body &&
      typeof body.error === "string"
      ? body.error
      : fallback,
  );
};

interface OwnedInventoryEntry {
  readonly environment: Environment;
  readonly createdAt: number;
}

export interface ManagedEnvironmentStore {
  readonly create: (
    input: CreateManagedEnvironmentInput,
  ) => Promise<ManagedEnvironment>;
  readonly findForUser: (
    userId: string,
    environmentId: string,
  ) => Promise<ManagedEnvironment | null>;
  readonly renameForUser: (input: {
    readonly userId: string;
    readonly environmentId: string;
    readonly displayName: string;
    readonly at: Date;
  }) => Promise<ManagedEnvironment | null>;
  readonly setStateForUser: (input: {
    readonly userId: string;
    readonly environmentId: string;
    readonly state: ManagedEnvironment["state"];
    readonly expectedGeneration: number;
    readonly at: Date;
  }) => Promise<ManagedEnvironment | null>;
  readonly deleteForUser: (input: {
    readonly userId: string;
    readonly environmentId: string;
    readonly expectedGeneration: number;
    readonly at: Date;
  }) => Promise<ManagedEnvironment | null>;
}

type SyncedProviderCredential = Omit<
  ManagedProviderCapability,
  "version" | "handle" | "expiresAt"
> & {
  readonly provider: "codex" | "claude";
  readonly authorizationHeader: string;
  readonly upstream: AuthCapabilityUpstream;
  readonly accountId?: string;
  readonly expiresAt: Date;
};

export interface EnvironmentRoutesDependencies {
  readonly enabled: boolean;
  readonly now: () => Date;
  readonly getUserId: (headers: Headers) => Promise<string | null>;
  readonly listOwned: (
    userId: string,
  ) => Promise<ReadonlyArray<OwnedInventoryEntry>>;
  readonly syncCapabilities?: (input: {
    readonly userId: string;
    readonly providerCredential: SyncedProviderCredential | null;
    readonly includeGitHub: boolean;
  }) => Promise<void>;
  readonly store: ManagedEnvironmentStore;
  readonly issueGrant: (input: {
    readonly userId: string;
    readonly environment: ManagedEnvironment;
    readonly request: ManagedEnvironmentGrantRequestValue;
    readonly reservationId: string | null;
  }) => Promise<ManagedEnvironmentGrantResponse>;
  readonly reserveStart?: (input: {
    readonly userId: string;
    readonly environmentId: string;
    readonly sessionId: string;
    readonly usageIntervalId: string;
  }) => Promise<ManagedUsageReservationResult>;
  readonly releaseStart?: (input: {
    readonly userId: string;
    readonly reservationId: string;
  }) => Promise<void>;
  readonly destroyEnvironment?: (input: {
    readonly userId: string;
    readonly environmentId: string;
  }) => Promise<void>;
  readonly destroySession?: (input: {
    readonly userId: string;
    readonly environmentId: string;
    readonly sessionId: string;
  }) => Promise<void>;
  readonly releaseSessionStart?: (input: {
    readonly userId: string;
    readonly environmentId: string;
    readonly sessionId: string;
  }) => Promise<void>;
  readonly hydrateWorkspace?: (input: {
    readonly userId: string;
    readonly environment: ManagedEnvironment;
    readonly sessionId: string;
    readonly connectionId: string;
    readonly providerId: string;
    readonly modelId: string;
    readonly plan: Schema.Schema.Type<typeof WorkspaceProvisioningPlan>;
  }) => Promise<void>;
}

const persistentStore: ManagedEnvironmentStore = {
  create: (input) =>
    runtime.runPromise(ManagedEnvironmentRepository.create(input)),
  findForUser: (userId, environmentId) =>
    runtime.runPromise(
      ManagedEnvironmentRepository.findForUser(userId, environmentId),
    ),
  renameForUser: (input) =>
    runtime.runPromise(ManagedEnvironmentRepository.renameForUser(input)),
  setStateForUser: (input) =>
    runtime.runPromise(ManagedEnvironmentRepository.setStateForUser(input)),
  deleteForUser: (input) =>
    runtime.runPromise(ManagedEnvironmentRepository.deleteForUser(input)),
};

const defaultDependencies = (): EnvironmentRoutesDependencies => ({
  enabled: env.managedEnvironmentsEnabled,
  now: () => new Date(),
  getUserId: async (headers) => {
    const session = await getAuth()
      .api.getSession({ headers })
      .catch(() => null);
    return session?.user?.id ?? null;
  },
  listOwned: async (userId) => {
    const devices = await loadAccountDevicesForUser(userId);
    return devices.map((device) => ({
      createdAt: device.createdAt,
      environment: {
        kind: "owned",
        id: device.deviceId,
        name: device.displayName,
        platform: device.platform,
        capabilities: device.capabilities,
        state:
          device.state === "revoked"
            ? "revoked"
            : !device.capabilities.capabilities.includes("session.start")
              ? "incompatible"
              : device.presence.state,
        agentVersion: device.agentVersion ?? null,
        lastSeenAt: device.presence.lastSeenAt,
      },
    }));
  },
  syncCapabilities: async ({ userId, providerCredential, includeGitHub }) => {
    const config = {
      enabled: env.managedEnvironmentsEnabled,
      url: env.authStateUrl,
      serviceSecret: env.authStateServiceSecret,
    };
    const github = includeGitHub
      ? await managedGitHubCapabilityForUser(userId)
      : undefined;
    await Promise.all([
      providerCredential === null
        ? Promise.resolve()
        : upsertAuthStateCapability(config, {
            userId,
            ...providerCredential,
          }),
      github === undefined
        ? Promise.resolve()
        : github === null
          ? deleteAuthStateCapability(config, { userId, provider: "github" })
          : upsertAuthStateCapability(config, {
              userId,
              provider: "github",
              ...github,
            }),
    ]);
  },
  store: persistentStore,
  issueGrant: async (input) => {
    const response = await fetch(
      `${env.managedRuntimeUrl.replace(/\/$/u, "")}/v1/grants`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.managedRuntimeServiceSecret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          version: 1,
          subject: input.userId,
          environmentId: input.environment.id,
          environmentGeneration: input.environment.generation,
          sessionId: input.request.sessionId,
          connectionId: input.request.connectionId,
          providerId: input.request.providerId,
          modelId: input.request.modelId,
          reservationId: input.reservationId,
          actions: input.request.actions,
        }),
      },
    );
    if (!response.ok)
      throw await runtimeError(response, "Managed runtime rejected the grant");
    return Schema.decodeUnknownSync(ManagedEnvironmentGrantResponse)(
      await response.json(),
      {
        onExcessProperty: "error",
      },
    );
  },
  reserveStart: (input) =>
    runtime.runPromise(
      ManagedUsageRepository.reserve({
        id: `usage_${crypto.randomUUID().replaceAll("-", "")}`,
        userId: input.userId,
        environmentId: input.environmentId,
        sessionId: input.sessionId,
        idempotencyKey: `managed-interval:${input.sessionId}:${input.usageIntervalId}`,
        policy: {
          maxConcurrentSessions: env.managedMaxConcurrentSessions,
          maxActiveSeconds: env.managedMaxActiveSeconds,
          dailyBudgetMicrousd: env.managedDailyBudgetMicrousd,
          maxEgressBytes: env.managedMaxEgressBytes,
          maxCheckpointBytes: env.managedMaxCheckpointBytes,
          checkpointRetentionSeconds: env.managedCheckpointRetentionSeconds,
        },
        now: new Date(),
      }),
    ),
  releaseStart: (input) =>
    runtime.runPromise(
      ManagedUsageRepository.release({
        userId: input.userId,
        reservationId: input.reservationId,
        now: new Date(),
      }),
    ),
  destroyEnvironment: async (input) => {
    const response = await fetch(
      `${env.managedRuntimeUrl.replace(/\/$/u, "")}/v1/environments/destroy`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.managedRuntimeServiceSecret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          subject: input.userId,
          environmentId: input.environmentId,
        }),
      },
    );
    if (!response.ok)
      throw await runtimeError(response, "Managed environment cleanup failed");
  },
  destroySession: async (input) => {
    const response = await fetch(
      `${env.managedRuntimeUrl.replace(/\/$/u, "")}/v1/sessions/destroy`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.managedRuntimeServiceSecret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          subject: input.userId,
          environmentId: input.environmentId,
          sessionId: input.sessionId,
        }),
      },
    );
    if (!response.ok)
      throw await runtimeError(response, "Managed session cleanup failed");
  },
  releaseSessionStart: (input) =>
    runtime.runPromise(
      ManagedUsageRepository.releaseReservedForSession({
        ...input,
        now: new Date(),
      }),
    ),
  hydrateWorkspace: async (input) => {
    const response = await fetch(
      `${env.managedRuntimeUrl.replace(/\/$/u, "")}/v1/workspaces/hydrate`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.managedRuntimeServiceSecret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          version: 1,
          subject: input.userId,
          environmentId: input.environment.id,
          environmentGeneration: input.environment.generation,
          sessionId: input.sessionId,
          connectionId: input.connectionId,
          providerId: input.providerId,
          modelId: input.modelId,
          plan: input.plan,
          repositoryUrl: `https://github.com/${input.plan.repository.slug}.git`,
        }),
      },
    );
    if (!response.ok)
      throw await runtimeError(response, "Managed workspace hydration failed");
  },
});

const ManagedWorkspaceRequest = Schema.Struct({
  version: Schema.Literal(1),
  sessionId: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128)),
  expectedGeneration: Schema.Int.pipe(Schema.positive()),
  ...ManagedRuntimeProviderSelection.fields,
  plan: WorkspaceProvisioningPlan,
});

const providerCredentialFrom = (
  request: Request,
  now = Date.now(),
): SyncedProviderCredential | null => {
  const encoded = request.headers.get("x-jingler-provider-credential")?.trim();
  if (!encoded) return null;
  try {
    const decoded = Schema.decodeUnknownEither(ManagedProviderCredential)(
      JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")),
      { onExcessProperty: "error" },
    );
    if (Either.isLeft(decoded)) return null;
    const credential = decoded.right;
    if (credential.authKind === "device-environment") return null;
    const routeMatches =
      (credential.authKind === "api-key" &&
        credential.billingRoute === "api") ||
      ((credential.authKind === "claude-setup-token" ||
        credential.authKind === "openai-codex-oauth") &&
        credential.billingRoute === "subscription");
    if (!routeMatches) return null;
    const expiresAt = Math.min(
      credential.expiresAt ?? now + 24 * 60 * 60 * 1_000,
      now + 24 * 60 * 60 * 1_000,
    );
    if (expiresAt <= now + 60_000) return null;
    if (
      credential.providerId === "openai-codex" &&
      credential.authKind === "openai-codex-oauth" &&
      credential.accountId !== null
    ) {
      return {
        provider: "codex",
        proxy: "codex",
        connectionId: credential.connectionId,
        providerId: credential.providerId,
        authKind: credential.authKind,
        billingRoute: credential.billingRoute,
        authorizationHeader: `Bearer ${credential.access}`,
        upstream: "chatgpt-codex",
        accountId: credential.accountId,
        expiresAt: new Date(expiresAt),
      };
    }
    if (
      credential.providerId === "openai" &&
      credential.authKind === "api-key"
    ) {
      return {
        provider: "codex",
        proxy: "codex",
        connectionId: credential.connectionId,
        providerId: credential.providerId,
        authKind: credential.authKind,
        billingRoute: credential.billingRoute,
        authorizationHeader: `Bearer ${credential.access}`,
        upstream: "openai-api",
        expiresAt: new Date(expiresAt),
      };
    }
    if (credential.providerId === "anthropic") {
      return {
        provider: "claude",
        proxy: "claude",
        connectionId: credential.connectionId,
        providerId: credential.providerId,
        authKind: credential.authKind,
        billingRoute: credential.billingRoute,
        authorizationHeader:
          credential.authKind === "claude-setup-token"
            ? `Bearer ${credential.access}`
            : `X-Api-Key ${credential.access}`,
        upstream: "anthropic-api",
        expiresAt: new Date(expiresAt),
      };
    }
    return null;
  } catch {
    return null;
  }
};

const matchesProviderSelection = (
  credential: SyncedProviderCredential | null,
  selection: Schema.Schema.Type<typeof ManagedRuntimeProviderSelection>,
): credential is SyncedProviderCredential =>
  credential !== null &&
  credential.connectionId === selection.connectionId &&
  credential.providerId === selection.providerId;

/**
 * Cloud is an account-scoped execution target, not a user-managed machine.
 * The stable opaque id keeps sessions and checkpoints addressable without
 * exposing the account id or requiring an inventory row before first use.
 */
export const managedCloudIdForUser = (userId: string): string =>
  `managed_cloud_${crypto.createHash("sha256").update(userId).digest("hex").slice(0, 32)}`;

const managedCloudCapabilities = (): ManagedEnvironment["capabilities"] => ({
  version: 1,
  capabilities: [
    "session.start",
    "session.input",
    "session.cancel",
    "session.observe",
  ],
  maxConcurrentSessions: 1,
});

const managedCloudEnvironment = (userId: string): ManagedEnvironment => ({
  kind: "managed",
  id: managedCloudIdForUser(userId),
  name: "Cloud",
  platform: { os: "linux", arch: "x64" },
  capabilities: managedCloudCapabilities(),
  state: "online",
  agentVersion: null,
  lastSeenAt: null,
  region: null,
  instanceType: "basic",
  generation: 1,
  createdAt: 0,
  updatedAt: 0,
});

const ensureManagedCloudEnvironment = async (
  dependencies: EnvironmentRoutesDependencies,
  userId: string,
): Promise<ManagedEnvironment> => {
  const environmentId = managedCloudIdForUser(userId);
  const existing = await dependencies.store.findForUser(userId, environmentId);
  if (existing) {
    return {
      ...existing,
      name: "Cloud",
      state: "online",
      capabilities: managedCloudCapabilities(),
    };
  }
  const created = await dependencies.store.create({
    id: environmentId,
    userId,
    displayName: "Cloud",
    region: null,
    instanceType: "basic",
    capabilities: managedCloudCapabilities(),
    idempotencyKey: MANAGED_CLOUD_IDEMPOTENCY_KEY,
    at: dependencies.now(),
  });
  return {
    ...created,
    name: "Cloud",
    state: "online",
    capabilities: managedCloudCapabilities(),
  };
};

const lifecycleState = (
  action: ManagedEnvironmentLifecycleRequestValue["action"],
): ManagedEnvironment["state"] => {
  switch (action) {
    case "start":
      return "provisioning";
    case "pause":
      return "paused";
    case "restore":
      return "restoring";
  }
};

export const createEnvironmentRoutes = (
  dependenciesFactory: () => EnvironmentRoutesDependencies = defaultDependencies,
) => {
  const routes = new Hono();

  const authenticate = async (
    request: Request,
    dependencies: EnvironmentRoutesDependencies,
  ) => dependencies.getUserId(request.headers);

  routes.get("/", async (context) => {
    const dependencies = dependenciesFactory();
    const userId = await authenticate(context.req.raw, dependencies);
    if (!userId) return json({ error: "Authentication required" }, 401);
    try {
      if (!dependencies.enabled) {
        const owned = await dependencies.listOwned(userId);
        return json(
          Schema.decodeUnknownSync(EnvironmentInventoryResponse)({
            version: 1,
            environments: [...owned]
              .sort(
                (left, right) =>
                  left.createdAt - right.createdAt ||
                  left.environment.id.localeCompare(right.environment.id),
              )
              .map((entry) => entry.environment),
          }),
        );
      }
      const owned = await dependencies.listOwned(userId);
      const environments = [
        ...[...owned]
          .sort(
            (left, right) =>
              left.createdAt - right.createdAt ||
              left.environment.id.localeCompare(right.environment.id),
          )
          .map((entry) => entry.environment),
        managedCloudEnvironment(userId),
      ];
      return json(
        Schema.decodeUnknownSync(EnvironmentInventoryResponse)({
          version: 1,
          environments,
        }),
      );
    } catch {
      return json({ error: "Environment inventory unavailable" }, 503);
    }
  });

  routes.post("/managed", async (context) => {
    const dependencies = dependenciesFactory();
    if (!dependencies.enabled)
      return json({ error: "Managed environments disabled" }, 404);
    const userId = await authenticate(context.req.raw, dependencies);
    if (!userId) return json({ error: "Authentication required" }, 401);
    const input = await decodeBoundedJson(
      context.req.raw,
      CreateManagedEnvironmentRequest,
    );
    if (!input)
      return json({ error: "Invalid managed environment request" }, 400);
    const providerCredential = providerCredentialFrom(context.req.raw);
    if (providerCredential === null) {
      return json(
        {
          error:
            "Managed Cloud requires an explicit Claude or Codex provider connection",
        },
        409,
      );
    }
    try {
      await dependencies.syncCapabilities?.({
        userId,
        providerCredential,
        includeGitHub: true,
      });
      const environment = await ensureManagedCloudEnvironment(
        dependencies,
        userId,
      );
      return json({ version: 1, environment });
    } catch {
      return json({ error: "Managed environment creation unavailable" }, 503);
    }
  });

  routes.post("/managed/:environmentId/rename", async (context) => {
    const dependencies = dependenciesFactory();
    const userId = await authenticate(context.req.raw, dependencies);
    if (!userId) return json({ error: "Authentication required" }, 401);
    if (context.req.param("environmentId") === managedCloudIdForUser(userId)) {
      return json({ error: "Cloud is managed automatically" }, 409);
    }
    const input = await decodeBoundedJson(
      context.req.raw,
      RenameManagedEnvironmentRequest,
    );
    if (!input) return json({ error: "Invalid rename request" }, 400);
    const environment = await dependencies.store
      .renameForUser({
        userId,
        environmentId: context.req.param("environmentId"),
        displayName: input.name.trim(),
        at: dependencies.now(),
      })
      .catch(() => null);
    return environment
      ? json({ version: 1, environment })
      : json({ error: "Managed environment not found" }, 404);
  });

  routes.post("/managed/:environmentId/lifecycle", async (context) => {
    const dependencies = dependenciesFactory();
    const userId = await authenticate(context.req.raw, dependencies);
    if (!userId) return json({ error: "Authentication required" }, 401);
    if (context.req.param("environmentId") === managedCloudIdForUser(userId)) {
      return json(
        { error: "Cloud sandboxes follow the session lifecycle" },
        409,
      );
    }
    const input = await decodeBoundedJson(
      context.req.raw,
      ManagedEnvironmentLifecycleRequest,
    );
    if (!input) return json({ error: "Invalid lifecycle request" }, 400);
    if (input.action === "pause" && dependencies.destroyEnvironment) {
      try {
        await dependencies.destroyEnvironment({
          userId,
          environmentId: context.req.param("environmentId"),
        });
      } catch (cause) {
        return cause instanceof ManagedRuntimeRequestError
          ? json({ error: cause.message }, cause.status)
          : json({ error: "Managed environment cleanup failed" }, 503);
      }
    }
    const environment = await dependencies.store
      .setStateForUser({
        userId,
        environmentId: context.req.param("environmentId"),
        state: lifecycleState(input.action),
        expectedGeneration: input.expectedGeneration,
        at: dependencies.now(),
      })
      .catch(() => null);
    return environment
      ? json({ version: 1, environment })
      : json({ error: "Managed environment generation changed" }, 409);
  });

  routes.post("/managed/:environmentId/workspaces", async (context) => {
    const dependencies = dependenciesFactory();
    if (!dependencies.enabled)
      return json({ error: "Managed environments disabled" }, 404);
    const userId = await authenticate(context.req.raw, dependencies);
    if (!userId) return json({ error: "Authentication required" }, 401);
    const input = await decodeBoundedJson(
      context.req.raw,
      ManagedWorkspaceRequest,
    );
    if (!input) return json({ error: "Invalid workspace request" }, 400);
    if (context.req.param("environmentId") !== managedCloudIdForUser(userId)) {
      return json({ error: "Managed environment not found" }, 404);
    }
    const environment = await ensureManagedCloudEnvironment(
      dependencies,
      userId,
    ).catch(() => null);
    if (!environment)
      return json({ error: "Managed environment not found" }, 404);
    if (environment.generation !== input.expectedGeneration) {
      return json({ error: "Managed environment generation changed" }, 409);
    }
    const providerCredential = providerCredentialFrom(context.req.raw);
    if (!matchesProviderSelection(providerCredential, input)) {
      return json(
        { error: "Managed provider connection does not match the workspace" },
        409,
      );
    }
    if (!dependencies.hydrateWorkspace) {
      return json({ error: "Managed workspace hydration unavailable" }, 503);
    }
    try {
      await dependencies.syncCapabilities?.({
        userId,
        providerCredential,
        includeGitHub: true,
      });
      await dependencies.hydrateWorkspace({
        userId,
        environment,
        sessionId: input.sessionId,
        connectionId: input.connectionId,
        providerId: input.providerId,
        modelId: input.modelId,
        plan: input.plan,
      });
      await dependencies.store.setStateForUser({
        userId,
        environmentId: environment.id,
        state: "online",
        expectedGeneration: environment.generation,
        at: dependencies.now(),
      });
      return json({ version: 1, hydrated: true });
    } catch (cause) {
      return cause instanceof ManagedRuntimeRequestError
        ? json({ error: cause.message }, cause.status)
        : json({ error: "Managed workspace hydration failed" }, 503);
    }
  });

  routes.post(
    "/managed/:environmentId/sessions/:sessionId/delete",
    async (context) => {
      const dependencies = dependenciesFactory();
      if (!dependencies.enabled)
        return json({ error: "Managed environments disabled" }, 404);
      const userId = await authenticate(context.req.raw, dependencies);
      if (!userId) return json({ error: "Authentication required" }, 401);
      const environmentId = context.req.param("environmentId");
      const sessionId = context.req.param("sessionId");
      if (environmentId !== managedCloudIdForUser(userId)) {
        return json({ error: "Managed environment not found" }, 404);
      }
      if (!dependencies.destroySession) {
        return json({ error: "Managed session cleanup unavailable" }, 503);
      }
      try {
        await dependencies.destroySession({ userId, environmentId, sessionId });
        await dependencies.releaseSessionStart?.({
          userId,
          environmentId,
          sessionId,
        });
        return json({ version: 1, deleted: true });
      } catch (cause) {
        return cause instanceof ManagedRuntimeRequestError
          ? json({ error: cause.message }, cause.status)
          : json({ error: "Managed session cleanup failed" }, 503);
      }
    },
  );

  routes.post("/managed/:environmentId/delete", async (context) => {
    const dependencies = dependenciesFactory();
    const userId = await authenticate(context.req.raw, dependencies);
    if (!userId) return json({ error: "Authentication required" }, 401);
    if (context.req.param("environmentId") === managedCloudIdForUser(userId)) {
      return json({ error: "Cloud is managed automatically" }, 409);
    }
    const input = await decodeBoundedJson(
      context.req.raw,
      DeleteManagedEnvironmentRequest,
    );
    if (!input) return json({ error: "Invalid delete request" }, 400);
    const current = await dependencies.store
      .findForUser(userId, context.req.param("environmentId"))
      .catch(() => null);
    if (!current) return json({ error: "Managed environment not found" }, 404);
    if (current.generation !== input.expectedGeneration) {
      return json({ error: "Managed environment generation changed" }, 409);
    }
    if (dependencies.destroyEnvironment) {
      try {
        await dependencies.destroyEnvironment({
          userId,
          environmentId: current.id,
        });
      } catch (cause) {
        return cause instanceof ManagedRuntimeRequestError
          ? json({ error: cause.message }, cause.status)
          : json({ error: "Managed environment cleanup failed" }, 503);
      }
    }
    const environment = await dependencies.store
      .deleteForUser({
        userId,
        environmentId: context.req.param("environmentId"),
        expectedGeneration: input.expectedGeneration,
        at: dependencies.now(),
      })
      .catch(() => null);
    return environment
      ? json({ version: 1 })
      : json({ error: "Managed environment not found" }, 404);
  });

  routes.post("/managed/:environmentId/grants", async (context) => {
    const dependencies = dependenciesFactory();
    if (!dependencies.enabled)
      return json({ error: "Managed environments disabled" }, 404);
    const userId = await authenticate(context.req.raw, dependencies);
    if (!userId) return json({ error: "Authentication required" }, 401);
    const request = await decodeBoundedJson(
      context.req.raw,
      ManagedEnvironmentGrantRequest,
    );
    if (!request) return json({ error: "Invalid managed grant request" }, 400);
    if (context.req.param("environmentId") !== managedCloudIdForUser(userId)) {
      return json({ error: "Managed environment not found" }, 404);
    }
    const environment = await ensureManagedCloudEnvironment(
      dependencies,
      userId,
    ).catch(() => null);
    if (!environment)
      return json({ error: "Managed environment not found" }, 404);
    if (environment.generation !== request.expectedGeneration) {
      return json({ error: "Managed environment generation changed" }, 409);
    }
    const providerCredential = providerCredentialFrom(context.req.raw);
    if (!matchesProviderSelection(providerCredential, request)) {
      return json(
        { error: "Managed provider connection does not match the session" },
        409,
      );
    }
    const metered = request.actions.some(
      (action) => action === "session.start" || action === "session.input",
    );
    if (metered) {
      try {
        await dependencies.syncCapabilities?.({
          userId,
          providerCredential,
          includeGitHub: false,
        });
      } catch {
        return json({ error: "Managed authorization sync unavailable" }, 503);
      }
    }
    const reservation =
      metered && dependencies.reserveStart
        ? await dependencies
            .reserveStart({
              userId,
              environmentId: environment.id,
              sessionId: request.sessionId,
              usageIntervalId: request.usageIntervalId,
            })
            .catch(() => null)
        : null;
    if (metered && dependencies.reserveStart && reservation === null) {
      return json(
        { error: "Managed usage budget is temporarily unavailable" },
        503,
      );
    }
    if (reservation?.status === "denied") {
      return json(
        {
          error:
            reservation.reason === "concurrency"
              ? "Only one managed session can run at a time"
              : "The daily managed-compute budget has been reached",
        },
        429,
      );
    }
    try {
      return json(
        await dependencies.issueGrant({
          userId,
          environment,
          request,
          reservationId: reservation?.reservationId ?? null,
        }),
      );
    } catch (cause) {
      if (reservation?.status === "reserved" && dependencies.releaseStart) {
        await dependencies
          .releaseStart({
            userId,
            reservationId: reservation.reservationId,
          })
          .catch(() => undefined);
      }
      return cause instanceof ManagedRuntimeRequestError
        ? json({ error: cause.message }, cause.status)
        : json({ error: "Managed runtime unavailable" }, 503);
    }
  });

  return routes;
};
