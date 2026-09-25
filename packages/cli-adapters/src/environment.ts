import type {
  AccountDevice,
  DeviceEnrollmentCredentialResponse,
  DeviceRelayGrantResponse,
  Environment,
  EnvironmentDiscovery,
  ManagedEnvironment,
  ManagedEnvironmentGrantResponse,
  ManagedProviderCredential,
  ManagedRuntimeProviderSelection,
  ManagedRuntimeAction,
  PairSshEnvironmentInput,
  ProviderConnectionId,
  RemoteDevice,
  WorkspaceProvisioningPlan,
} from "@jingler/core";
import {
  AccountDeviceListResponse as AccountDeviceListResponseSchema,
  DeviceEnrollmentCredentialResponse as DeviceEnrollmentCredentialResponseSchema,
  DeviceRecord as DeviceRecordSchema,
  DeviceRelayGrantResponse as DeviceRelayGrantResponseSchema,
  EnvironmentError,
  EnvironmentDiscovery as EnvironmentDiscoverySchema,
  EnvironmentInventoryResponse as EnvironmentInventoryResponseSchema,
  ManagedEnvironmentGrantResponse as ManagedEnvironmentGrantResponseSchema,
  ManagedProviderCredential as ManagedProviderCredentialSchema,
  REMOTE_PROTOCOL_VERSION,
} from "@jingler/core";
import { Effect, Schema } from "effect";
import type { DirectSshTarget } from "./device-secret-document.js";
import {
  readDeviceSecretDocument,
  updateDeviceSecretDocument,
} from "./device-secret-document.js";
import { RemoteBootstrapService } from "./remote-bootstrap.js";
import { SecretStore } from "./secret-store.js";
import { ProviderConnections } from "./runtime/providers/provider-connections.js";

const authBaseUrl = (): string =>
  process.env.JINGLER_AUTH_URL ?? "http://localhost:9100";
const deviceAgentBundlePath = (): string | undefined =>
  process.env.JINGLER_DEVICE_AGENT_BUNDLE;
const DEVICE_API_ROOT = "/api/devices";
const ENVIRONMENT_API_ROOT = "/api/environments";

type EnvironmentDevice = RemoteDevice | AccountDevice;

export const environmentFromRemoteDevice = (
  device: EnvironmentDevice,
): Environment => ({
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
  agentVersion: "agentVersion" in device ? (device.agentVersion ?? null) : null,
  lastSeenAt: device.presence.lastSeenAt,
});

const environmentError = (status: number, fallback: string): EnvironmentError =>
  new EnvironmentError({
    reason:
      status === 401
        ? "authentication"
        : status === 404
          ? "not-found"
          : status === 409 || status === 410
            ? "expired-code"
            : "unavailable",
    message: fallback,
  });

export class EnvironmentService extends Effect.Service<EnvironmentService>()(
  "@jingler/EnvironmentService",
  {
    accessors: true,
    effect: Effect.gen(function* () {
      const secrets = yield* SecretStore;
      const bootstrap = yield* RemoteBootstrapService;
      const providers = yield* ProviderConnections;
      const managedAuthHeaders = (
        connectionId: ProviderConnectionId,
      ): Effect.Effect<Record<string, string>, EnvironmentError> =>
        Effect.gen(function* () {
          const resolved = yield* providers
            .resolveCredential(connectionId)
            .pipe(
              Effect.mapError((cause) => environmentError(401, cause.message)),
            );
          const billingRoute =
            resolved.connection.subscription.confirmedBillingRoute;
          if (billingRoute === null) {
            return yield* Effect.fail(
              environmentError(
                409,
                "The selected provider billing route is not confirmed.",
              ),
            );
          }
          if (
            resolved.connection.providerId === "openai-codex" &&
            resolved.accountId === null
          ) {
            return yield* Effect.fail(
              environmentError(
                409,
                "The selected Codex connection has no account routing claim.",
              ),
            );
          }
          const credential: ManagedProviderCredential =
            yield* Schema.decodeUnknown(ManagedProviderCredentialSchema)({
              version: 1,
              connectionId: resolved.connection.id,
              providerId: resolved.connection.providerId,
              authKind: resolved.connection.authKind,
              access: resolved.access,
              expiresAt: resolved.expiresAt,
              accountId: resolved.accountId,
              billingRoute,
            }).pipe(
              Effect.mapError(() =>
                environmentError(
                  409,
                  "The selected provider credential is invalid.",
                ),
              ),
            );
          return {
            "x-jingler-provider-credential": Buffer.from(
              JSON.stringify(credential),
              "utf8",
            ).toString("base64url"),
          };
        });
      const clientInstanceId = yield* Effect.tryPromise({
        try: async () => {
          const document = await updateDeviceSecretDocument(
            secrets,
            (current) => {
              if (
                typeof current.clientInstanceId === "string" &&
                /^client_[A-Za-z0-9_-]{8,120}$/u.test(current.clientInstanceId)
              ) {
                return current;
              }
              return {
                ...current,
                clientInstanceId: `client_${crypto.randomUUID().replaceAll("-", "")}`,
              };
            },
          );
          return document.clientInstanceId!;
        },
        catch: () =>
          environmentError(503, "The device identity store is unavailable."),
      });

      const request = <A, I>(
        path: string,
        schema: Schema.Schema<A, I>,
        init?: RequestInit,
      ): Effect.Effect<A, EnvironmentError> =>
        Effect.gen(function* () {
          const token = yield* secrets.get;
          if (!token) {
            return yield* Effect.fail(
              new EnvironmentError({
                reason: "authentication",
                message: "Sign in to manage devices.",
              }),
            );
          }
          const response = yield* Effect.tryPromise({
            try: () =>
              fetch(`${authBaseUrl()}${path}`, {
                ...init,
                headers: {
                  ...Object.fromEntries(new Headers(init?.headers).entries()),
                  authorization: `Bearer ${token}`,
                  "x-jingler-client-instance-id": clientInstanceId,
                  ...(init?.body ? { "content-type": "application/json" } : {}),
                },
              }),
            catch: () =>
              environmentError(503, "The device service is unavailable."),
          });
          if (!response.ok) {
            const responseBody = yield* Effect.promise(
              () => response.json().catch(() => null) as Promise<unknown>,
            );
            const message =
              typeof responseBody === "object" &&
              responseBody !== null &&
              "error" in responseBody &&
              typeof responseBody.error === "string"
                ? responseBody.error
                : "The device request failed.";
            return yield* Effect.fail(
              environmentError(response.status, message),
            );
          }
          const body = yield* Effect.tryPromise({
            try: () => response.json(),
            catch: () =>
              environmentError(
                502,
                "The device service returned an invalid response.",
              ),
          });
          return yield* Schema.decodeUnknown(schema)(body).pipe(
            Effect.mapError(() =>
              environmentError(
                502,
                "The device service returned an invalid response.",
              ),
            ),
          );
        });

      const accountDevices = () =>
        request(DEVICE_API_ROOT, AccountDeviceListResponseSchema);

      const environmentsById = new Map<string, Environment>();
      const list = request(
        ENVIRONMENT_API_ROOT,
        EnvironmentInventoryResponseSchema,
      ).pipe(
        Effect.map((response) => response.environments),
        Effect.tap((environments) =>
          Effect.sync(() => {
            for (const candidate of environments) {
              environmentsById.set(candidate.id, candidate);
            }
          }),
        ),
      );

      const environment = (
        environmentId: string,
      ): Effect.Effect<Environment, EnvironmentError> => {
        const cached = environmentsById.get(environmentId);
        if (cached !== undefined) return Effect.succeed(cached);
        return list.pipe(
          Effect.flatMap((environments) => {
            const found = environments.find(
              (candidate) => candidate.id === environmentId,
            );
            return found
              ? Effect.succeed(found)
              : Effect.fail(
                  new EnvironmentError({
                    reason: "not-found",
                    message: "The selected environment is no longer available.",
                  }),
                );
          }),
        );
      };

      const kind = (
        environmentId: string,
      ): Effect.Effect<Environment["kind"], EnvironmentError> => {
        const cached = environmentsById.get(environmentId);
        return cached === undefined
          ? environment(environmentId).pipe(Effect.map((value) => value.kind))
          : Effect.succeed(cached.kind);
      };

      const device = (
        deviceId: string,
      ): Effect.Effect<EnvironmentDevice, EnvironmentError> =>
        accountDevices().pipe(
          Effect.flatMap((response) => {
            const found = response.devices.find(
              (candidate) => candidate.deviceId === deviceId,
            );
            return found
              ? Effect.succeed(found)
              : Effect.fail(
                  new EnvironmentError({
                    reason: "not-found",
                    message: "The selected device is no longer available.",
                  }),
                );
          }),
        );

      const sessionGrant = (
        deviceId: string,
        sessionId: string,
      ): Effect.Effect<DeviceRelayGrantResponse, EnvironmentError> =>
        request(`${DEVICE_API_ROOT}/grants`, DeviceRelayGrantResponseSchema, {
          method: "POST",
          body: JSON.stringify({
            version: REMOTE_PROTOCOL_VERSION,
            audience: "session-tunnel",
            deviceId,
            sessionId,
            clientInstanceId,
            attachmentGeneration: null,
            controllerLeaseGeneration: null,
          }),
        });

      const managedSessionGrant = (
        environment: ManagedEnvironment,
        sessionId: string,
        usageIntervalId: string,
        actions: ReadonlyArray<ManagedRuntimeAction>,
        selection: ManagedRuntimeProviderSelection,
      ): Effect.Effect<ManagedEnvironmentGrantResponse, EnvironmentError> =>
        Effect.gen(function* () {
          const headers = yield* managedAuthHeaders(selection.connectionId);
          return yield* request(
            `${ENVIRONMENT_API_ROOT}/managed/${encodeURIComponent(environment.id)}/grants`,
            ManagedEnvironmentGrantResponseSchema,
            {
              method: "POST",
              headers,
              body: JSON.stringify({
                version: REMOTE_PROTOCOL_VERSION,
                sessionId,
                usageIntervalId,
                expectedGeneration: environment.generation,
                ...selection,
                actions,
              }),
            },
          );
        });

      const hydrateManagedWorkspace = (
        environment: ManagedEnvironment,
        sessionId: string,
        plan: WorkspaceProvisioningPlan,
        selection: ManagedRuntimeProviderSelection,
      ): Effect.Effect<void, EnvironmentError> =>
        Effect.gen(function* () {
          const headers = yield* managedAuthHeaders(selection.connectionId);
          yield* request(
            `${ENVIRONMENT_API_ROOT}/managed/${encodeURIComponent(environment.id)}/workspaces`,
            Schema.Struct({
              version: Schema.Literal(1),
              hydrated: Schema.Literal(true),
            }),
            {
              method: "POST",
              headers,
              body: JSON.stringify({
                version: 1,
                sessionId,
                expectedGeneration: environment.generation,
                ...selection,
                plan,
              }),
            },
          ).pipe(Effect.asVoid);
        });

      const cleanupManagedSession = (
        environment: ManagedEnvironment,
        sessionId: string,
      ): Effect.Effect<void, EnvironmentError> =>
        request(
          `${ENVIRONMENT_API_ROOT}/managed/${encodeURIComponent(environment.id)}/sessions/${encodeURIComponent(sessionId)}/delete`,
          Schema.Struct({
            version: Schema.Literal(1),
            deleted: Schema.Literal(true),
          }),
          { method: "POST" },
        ).pipe(Effect.asVoid);

      const enrollmentCredential = (
        deviceId: string,
      ): Effect.Effect<DeviceEnrollmentCredentialResponse, EnvironmentError> =>
        request(
          `${DEVICE_API_ROOT}/enrollment-credentials`,
          DeviceEnrollmentCredentialResponseSchema,
          {
            method: "POST",
            body: JSON.stringify({
              version: REMOTE_PROTOCOL_VERSION,
              deviceId,
              clientInstanceId,
            }),
          },
        );

      const pairSsh = (input: PairSshEnvironmentInput) =>
        Effect.gen(function* () {
          const agentBundlePath = deviceAgentBundlePath();
          if (!agentBundlePath) {
            return yield* Effect.fail(
              new EnvironmentError({
                reason: "unavailable",
                message: "The device agent bundle is unavailable.",
              }),
            );
          }
          const deviceId = `device_${crypto.randomUUID().replaceAll("-", "")}`;
          const credential = yield* enrollmentCredential(deviceId);
          const enrolled = yield* bootstrap
            .installAndEnroll({
              host: input.host,
              ...(input.username === undefined
                ? {}
                : { username: input.username }),
              ...(input.port === undefined ? {} : { port: input.port }),
              agentBundlePath,
              serverUrl: authBaseUrl(),
              credential,
            })
            .pipe(
              Effect.mapError(
                (error) =>
                  new EnvironmentError({
                    reason:
                      error.kind === "incompatible" ? "incompatible" : "ssh",
                    message: error.message,
                  }),
              ),
            );
          const response = yield* accountDevices();
          const registered = response.devices.find(
            (candidate) => candidate.deviceId === enrolled.deviceId,
          );
          if (!registered) {
            return yield* Effect.fail(
              environmentError(
                502,
                "The enrolled device was not returned by the registry.",
              ),
            );
          }
          yield* Effect.tryPromise({
            try: () =>
              updateDeviceSecretDocument(secrets, (document) => ({
                ...document,
                directSshTargets: {
                  ...document.directSshTargets,
                  [registered.deviceId]: {
                    host: input.host,
                    ...(input.username === undefined
                      ? {}
                      : { username: input.username }),
                    ...(input.port === undefined ? {} : { port: input.port }),
                  },
                },
              })),
            catch: () =>
              environmentError(503, "The SSH connection could not be saved."),
          });
          return environmentFromRemoteDevice(registered);
        });

      const directSsh = (
        deviceId: string,
      ): Effect.Effect<DirectSshTarget | null, EnvironmentError> =>
        Effect.tryPromise({
          try: async () => {
            const target = (await readDeviceSecretDocument(secrets))
              .directSshTargets?.[deviceId];
            if (
              !target ||
              typeof target.host !== "string" ||
              !/^[A-Za-z0-9_][A-Za-z0-9._-]{0,252}$/u.test(target.host)
            )
              return null;
            if (
              target.username !== undefined &&
              !/^[A-Za-z_][A-Za-z0-9._-]{0,63}$/u.test(target.username)
            )
              return null;
            if (
              target.port !== undefined &&
              (!Number.isSafeInteger(target.port) ||
                target.port < 1 ||
                target.port > 65_535)
            )
              return null;
            return target;
          },
          catch: () =>
            environmentError(503, "The saved SSH connection is unavailable."),
        });

      const rename = (deviceId: string, name: string) =>
        Effect.gen(function* () {
          const trimmed = name.trim();
          if (!trimmed) {
            return yield* Effect.fail(
              new EnvironmentError({
                reason: "invalid-input",
                message: "Enter a device name.",
              }),
            );
          }
          const result = yield* request(
            `${DEVICE_API_ROOT}/${encodeURIComponent(deviceId)}/rename`,
            Schema.Struct({
              version: Schema.Literal(1),
              device: Schema.Unknown,
            }),
            {
              method: "POST",
              body: JSON.stringify({
                version: 1,
                deviceId,
                displayName: trimmed,
              }),
            },
          );
          const device = yield* Schema.decodeUnknown(DeviceRecordSchema)(
            result.device,
          ).pipe(
            Effect.mapError(() =>
              environmentError(
                502,
                "The device service returned an invalid response.",
              ),
            ),
          );
          const current = yield* accountDevices();
          const joined = current.devices.find(
            (candidate) => candidate.deviceId === device.deviceId,
          );
          const fallback: Environment = {
            kind: "owned",
            id: device.deviceId,
            name: device.displayName,
            platform: device.platform,
            capabilities: device.capabilities,
            state: device.state === "revoked" ? "revoked" : "offline",
            agentVersion: null,
            lastSeenAt: null,
          };
          return joined ? environmentFromRemoteDevice(joined) : fallback;
        });

      const revoke = (deviceId: string) =>
        Effect.gen(function* () {
          yield* request(
            `${DEVICE_API_ROOT}/${encodeURIComponent(deviceId)}/revoke`,
            Schema.Unknown,
            {
              method: "POST",
            },
          );
          yield* Effect.tryPromise({
            try: () =>
              updateDeviceSecretDocument(secrets, (document) => {
                if (!document.directSshTargets?.[deviceId]) return document;
                const directSshTargets = { ...document.directSshTargets };
                delete directSshTargets[deviceId];
                return { ...document, directSshTargets };
              }),
            catch: () =>
              environmentError(
                503,
                "The saved SSH connection could not be removed.",
              ),
          });
        }).pipe(Effect.asVoid);

      const discovery = (
        deviceId: string,
        endpointRequest?: { readonly targetId: string; readonly action: "list" | "refresh" | "auth-status" },
      ): Effect.Effect<EnvironmentDiscovery, EnvironmentError> =>
        request(
          `${DEVICE_API_ROOT}/${encodeURIComponent(deviceId)}/discovery`,
          EnvironmentDiscoverySchema,
          endpointRequest ? { method: "POST", body: JSON.stringify(endpointRequest) } : undefined,
        ).pipe(
          Effect.tap((response) => Effect.sync(() => {
            const current = environmentsById.get(deviceId);
            if (current?.kind === "owned" && response.discovery !== null) {
              environmentsById.set(deviceId, {
                ...current,
                capabilities: response.discovery.capabilities,
                agentVersion: response.discovery.agentVersion,
              });
            }
          })),
        );

      return {
        list,
        environment,
        kind,
        device,
        sessionGrant,
        managedSessionGrant,
        discovery,
        refresh: list,
        suggestHosts: bootstrap.discoverHosts,
        pairSsh,
        hydrateManagedWorkspace,
        cleanupManagedSession,
        directSsh,
        rename,
        revoke,
      } as const;
    }),
  },
) {}
