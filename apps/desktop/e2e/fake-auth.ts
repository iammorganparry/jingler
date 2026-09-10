import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  CURRENT_RUNTIME_CONTRACTS,
  ManagedProviderCredential as ManagedProviderCredentialSchema,
} from "@jingler/core";
import { Either, Option, Schema } from "effect";

const DEFAULT_TOKEN = "e2e-token";

export interface FakeManagedRequest {
  readonly path: string;
  readonly connectionId: string | null;
  readonly providerId: string | null;
  readonly modelId: string | null;
  readonly authKind: string | null;
  readonly billingRoute: string | null;
  readonly accountIdPresent: boolean;
  readonly credentialPresent: boolean;
}

export interface FakeAuthServerOptions {
  readonly token?: string;
  /** Forward production `/api/devices` desktop routes to the hermetic device relay. */
  readonly deviceRelayUrl?: string;
  readonly listenHost?: string;
  readonly publicHost?: string;
  readonly unavailableSocialProviders?: ReadonlyArray<"github" | "google">;
  readonly managedRuntime?: "current" | "missing" | "stale";
  readonly offloadResult?: "success" | "failed" | "hold";
}

/** Offline BetterAuth and managed-environment fake. */
export interface FakeOffloadRequest {
  readonly kind: "prime" | "admit" | "upload" | "events" | "cancel" | "destroy"
  readonly path: string
}

export interface FakeAuthServer {
  readonly url: string;
  readonly token: string;
  readonly sentEmails: ReadonlyArray<string>;
  readonly managedRequests: ReadonlyArray<FakeManagedRequest>;
  readonly offloadRequests: ReadonlyArray<FakeOffloadRequest>;
  readonly close: () => Promise<void>;
}

const decodeJsonBody = Schema.decodeUnknownOption(
  Schema.Record({ key: Schema.String, value: Schema.Unknown }),
);

const jsonBody = (value: unknown): Record<string, unknown> =>
  Option.getOrElse(decodeJsonBody(value), () => ({}));

interface RedactedManagedCredential {
  readonly connectionId: string;
  readonly providerId: string;
  readonly authKind: string;
  readonly billingRoute: string;
  readonly accountIdPresent: boolean;
}

const managedCredential = (
  header: string | string[] | undefined,
): RedactedManagedCredential | null => {
  if (typeof header !== "string") return null;
  try {
    const decoded = Schema.decodeUnknownEither(ManagedProviderCredentialSchema)(
      JSON.parse(Buffer.from(header, "base64url").toString("utf8")),
      { onExcessProperty: "error" },
    );
    if (Either.isLeft(decoded)) return null;
    return {
      connectionId: decoded.right.connectionId,
      providerId: decoded.right.providerId,
      authKind: decoded.right.authKind,
      billingRoute: decoded.right.billingRoute,
      accountIdPresent: decoded.right.accountId !== null,
    };
  } catch {
    return null;
  }
};

const normalizeOptions = (
  value: string | FakeAuthServerOptions,
): Required<Omit<FakeAuthServerOptions, "deviceRelayUrl">> & {
  readonly deviceRelayUrl?: string;
} =>
  typeof value === "string"
    ? {
        token: value,
        managedRuntime: "current",
        offloadResult: "success",
        unavailableSocialProviders: [],
        listenHost: "127.0.0.1",
        publicHost: "127.0.0.1",
      }
    : {
        token: value.token ?? DEFAULT_TOKEN,
        managedRuntime: value.managedRuntime ?? "current",
        offloadResult: value.offloadResult ?? "success",
        unavailableSocialProviders: value.unavailableSocialProviders ?? [],
        listenHost: value.listenHost ?? "127.0.0.1",
        publicHost: value.publicHost ?? "127.0.0.1",
        ...(value.deviceRelayUrl ? { deviceRelayUrl: value.deviceRelayUrl } : {}),
      };

export const startFakeAuthServer = async (
  input: string | FakeAuthServerOptions = {},
): Promise<FakeAuthServer> => {
  const options = normalizeOptions(input);
  const sentEmails: Array<string> = [];
  const managedRequests: Array<FakeManagedRequest> = [];
  const offloadRequests: Array<FakeOffloadRequest> = [];
  let offloadEventReads = 0;

  const server: Server = createServer((req, res) => {
    const host = req.headers.host ?? "localhost";
    const url = new URL(req.url ?? "/", `http://${host}`);
    const json = (
      code: number,
      body: unknown,
      headers: Readonly<Record<string, string>> = {},
    ) => {
      res.writeHead(code, { "Content-Type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    const readJson = (): Promise<unknown> =>
      new Promise((resolve) => {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve(null);
          }
        });
      });

    const routes = [
      {
        matches: () => (url.pathname === "/api/offload/prime" && req.method === "POST"),
        handle: function primeOffload() {
          offloadRequests.push({ kind: "prime", path: url.pathname });
          return json(202, { accepted: true });
        }
      },
      {
        matches: () => (url.pathname === "/api/offload/sandboxes/destroy" && req.method === "POST"),
        handle: function destroyOffload() {
          offloadRequests.push({ kind: "destroy", path: url.pathname });
          return json(200, { destroyed: true });
        }
      },
      {
        matches: () => (url.pathname === "/api/offload/jobs" && req.method === "POST"),
        handle: function admitOffload() {
          offloadRequests.push({ kind: "admit", path: url.pathname });
          const runtimeUrl = `http://${host}`;
          return json(200, {
            version: 1,
            jobId: "job_e2e_aaaaaaaaaaaaaaaa",
            runtimeUrl,
            uploadUrl: `${runtimeUrl}/v1/offload/jobs/job_e2e_aaaaaaaaaaaaaaaa/snapshot`,
            grant: "grant_e2e_aaaaaaaaaaaaaaaa",
            expiresAt: Math.floor(Date.now() / 1_000) + 300,
          });
        }
      },
      {
        matches: () => (/^\/v1\/offload\/jobs\/[^/]+\/snapshot$/u.test(url.pathname) && req.method === "PUT"),
        handle: function uploadOffload() {
          offloadRequests.push({ kind: "upload", path: url.pathname });
          req.resume();
          req.on("end", () => json(202, { accepted: true }));
          return;
        }
      },
      {
        matches: () => (/^\/v1\/offload\/jobs\/[^/]+\/events$/u.test(url.pathname) && req.method === "GET"),
        handle: function offloadEvents() {
          offloadRequests.push({ kind: "events", path: url.pathname });
          offloadEventReads += 1;
          const jobId = "job_e2e_aaaaaaaaaaaaaaaa";
          if (offloadEventReads === 1 || options.offloadResult === "hold") {
            return json(200, {
              version: 1,
              jobId,
              state: "preparing",
              cursor: 1,
              events: [{
                version: 1,
                jobId,
                sequence: 1,
                kind: "state",
                state: "preparing",
              }],
              result: null,
            });
          }
          const failed = options.offloadResult === "failed";
          const result = offloadResult(failed, jobId);
          return json(200, {
            version: 1,
            jobId,
            state: result.state,
            cursor: 3,
            events: [
              {
                version: 1,
                jobId,
                sequence: 2,
                kind: "output",
                stream: failed ? "stderr" : "stdout",
                text: failed ? "remote typecheck failed" : "remote typecheck clean",
              },
              { version: 1, jobId, sequence: 3, kind: "result", result },
            ],
            result,
          });
        }
      },
      {
        matches: () => (/^\/v1\/offload\/jobs\/[^/]+\/cancel$/u.test(url.pathname) && req.method === "POST"),
        handle: function cancelOffload() {
          offloadRequests.push({ kind: "cancel", path: url.pathname });
          return json(202, { cancelled: true });
        }
      },
      {
        matches: () => (options.deviceRelayUrl && url.pathname.startsWith("/api/devices")),
        handle: function forwardDevices() {
          void (async () => {
            const body =
              req.method === "GET" ? undefined : JSON.stringify(await readJson());
            const forwarded = await fetch(
              `${options.deviceRelayUrl}${url.pathname}${url.search}`,
              {
                method: req.method,
                headers: forwardedDeviceHeaders(req.headers.authorization, body),
                ...(body ? { body } : {}),
              },
            );
            res.writeHead(forwarded.status, {
              "content-type":
                forwarded.headers.get("content-type") ?? "application/json",
            });
            res.end(await forwarded.text());
          })().catch(() => json(502, { error: "device relay unavailable" }));
          return;
        }
      },
      {
        matches: () => (url.pathname === "/api/environments/web-search-credential" &&
          (req.method === "PUT" || req.method === "DELETE")),
        handle: function updateWebSearch() {
          if (req.headers.authorization !== `Bearer ${options.token}`)
            return json(401, {});
          void readJson().then(() =>
            json(200, { synced: req.method === "PUT" })
          );
          return;
        }
      },
      {
        matches: () => (url.pathname === "/api/environments" && req.method === "GET"),
        handle: function listEnvironments() {
          if (req.headers.authorization !== `Bearer ${options.token}`)
            return json(401, {});
          void (async () => {
            const owned = options.deviceRelayUrl
              ? await fetch(`${options.deviceRelayUrl}/api/devices`, {
                headers: { authorization: `Bearer ${options.token}` },
              })
                .then((response) => response.json())
                .then((body) =>
                  Array.isArray((body as { devices?: unknown }).devices)
                    ? (
                      body as { devices: Array<Record<string, unknown>> }
                    ).devices.map((device) => ({
                      kind: "owned",
                      id: device.deviceId,
                      name: device.displayName,
                      platform: device.platform,
                      capabilities: device.capabilities,
                      state:
                        Array.isArray(
                          (
                            device.capabilities as
                            { capabilities?: unknown } | undefined
                          )?.capabilities,
                        ) &&
                          !(
                            device.capabilities as {
                              capabilities: Array<unknown>;
                            }
                          ).capabilities.includes("session.start")
                          ? "incompatible"
                          : ((
                            device.presence as { state?: unknown } | undefined
                          )?.state ?? "offline"),
                      agentVersion: device.agentVersion ?? null,
                      lastSeenAt:
                        (
                          device.presence as
                          { lastSeenAt?: unknown } | undefined
                        )?.lastSeenAt ?? null,
                    }))
                    : [],
                )
              : [];
            json(200, {
              version: 1,
              environments: [
                ...owned,
                {
                  kind: "managed",
                  id: "managed_cloud_e2e_account",
                  name: "Cloud",
                  platform: { os: "linux", arch: "x64" },
                  capabilities: {
                    version: 1,
                    capabilities: [
                      "session.start",
                      "session.input",
                      "session.cancel",
                      "session.observe",
                    ],
                    maxConcurrentSessions: 1,
                    ...(options.managedRuntime === "missing"
                      ? {}
                      : {
                        runtime: {
                          versions: {
                            ...CURRENT_RUNTIME_CONTRACTS,
                            ...(options.managedRuntime === "stale"
                              ? { piSdk: "stale" }
                              : {}),
                          },
                          toolIds: [],
                          resourceIds: [],
                          targetId: "managed_cloud_e2e_account",
                        },
                      }),
                  },
                  state: "online",
                  agentVersion: null,
                  lastSeenAt: null,
                  region: null,
                  instanceType: "basic",
                  generation: 1,
                  createdAt: 0,
                  updatedAt: 0,
                },
              ],
            });
          })().catch(() =>
            json(502, { error: "environment inventory unavailable" }),
          );
          return;
        }
      },
      {
        matches: () => (url.pathname ===
          "/api/environments/managed/managed_cloud_e2e_account/workspaces" &&
          req.method === "POST"),
        handle: function createManagedWorkspace() {
          if (req.headers.authorization !== `Bearer ${options.token}`)
            return json(401, {});
          void readJson().then((value) => {
            const body = jsonBody(value);
            const credential = managedCredential(
              req.headers["x-jingler-provider-credential"],
            );
            managedRequests.push({
              path: url.pathname,
              connectionId:
                nullableString(body.connectionId),
              providerId:
                nullableString(body.providerId),
              modelId: nullableString(body.modelId),
              authKind: credential?.authKind ?? null,
              billingRoute: credential?.billingRoute ?? null,
              accountIdPresent: credential?.accountIdPresent ?? false,
              credentialPresent: credential !== null,
            });
            setTimeout(() => {
              json(503, {
                error: "Scripted Cloud startup stopped before allocation",
              });
            }, 2_000);
          });
          return;
        }
      },
      {
        matches: () => (url.pathname === "/api/auth/get-session"),
        handle: function getAuthSession() {
          if (req.headers.authorization === `Bearer ${options.token}`) {
            return json(200, {
              session: { expiresAt: "2099-01-01T00:00:00Z", token: options.token },
              user: {
                id: "u_e2e",
                email: "e2e@jingler.dev",
                name: "E2E User",
                image: null,
              },
            });
          }
          return json(401, {});
        }
      },
      {
        matches: () => (url.pathname === "/api/auth/sign-in/social" && req.method === "POST"),
        handle: function signInSocial() {
          readJson().then((value) => {
            const provider = jsonBody(value).provider;
            if (
              (provider === "github" || provider === "google") &&
              options.unavailableSocialProviders.includes(provider)
            ) {
              return json(404, {
                message: "Provider not found",
                code: "PROVIDER_NOT_FOUND",
              });
            }
            return json(200, {
              url: `http://${host}/desktop/callback?token=${options.token}`,
              redirect: true,
            });
          });
          return;
        }
      },
      {
        matches: () => (url.pathname === "/desktop/callback"),
        handle: function callbackAuth() {
          res.writeHead(302, {
            Location: `jingler://auth/callback?token=${options.token}`,
          });
          return res.end();
        }
      },
      {
        matches: () => (url.pathname === "/api/auth/sign-in/magic-link" &&
          req.method === "POST"),
        handle: function signInMagicLink() {
          readJson().then((value) => {
            const email = jsonBody(value).email;
            if (typeof email === "string" && email.includes("fail"))
              return json(400, { error: "rejected" });
            if (typeof email === "string") sentEmails.push(email);
            return json(200, { status: true });
          });
          return;
        }
      },
      {
        matches: () => (url.pathname === "/api/auth/sign-out" && req.method === "POST"),
        handle: function signOut() {
          return json(200, {});
        }
      }
    ];
    const route = routes.find((candidate) => candidate.matches());
    if (route) return route.handle();

    return json(404, {});
  });

  await new Promise<void>((resolve) =>
    server.listen(0, options.listenHost, resolve),
  );
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://${options.publicHost}:${port}`,
    token: options.token,
    get sentEmails() {
      return sentEmails;
    },
    get managedRequests() {
      return managedRequests;
    },
    get offloadRequests() {
      return offloadRequests;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

function offloadResult(failed: boolean, jobId: string) {
  return {
    version: 1,
    jobId,
    state: failed ? "failed" : "succeeded",
    exitCode: failed ? 2 : 0,
    failureReason: failed ? "command-failed" : null,
    stdout: failed ? "" : "remote typecheck clean",
    stderr: failed ? "remote typecheck failed" : "",
    outputTruncated: false,
    timings: {
      queuedMs: 1,
      snapshotMs: 2,
      hydrationMs: 3,
      dependencyMs: 4,
      commandMs: 5,
    },
  };
}

function forwardedDeviceHeaders(authorization: string | undefined, body: string | undefined) {
  return {
    ...(typeof authorization === "string"
      ? { authorization: authorization }
      : {}),
    ...(body ? { "content-type": "application/json" } : {}),
  };
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
