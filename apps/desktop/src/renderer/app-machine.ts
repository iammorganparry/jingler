/**
 * The renderer's top-level state machine. Modelling the first-run/loading/ready
 * flow as an XState chart keeps every async transition (initial load, folder
 * pick + scan, session load) inside declarative `fromPromise` actors — no
 * data-fetching `useEffect`s, minimal `useState`.
 */
import type {
  AgentEndpointCatalog,
  AuthKind,
  CodexLoginMethod,
  DetectedResourceCandidate,
  ProviderCatalog,
  ProviderConnection,
  ProviderConnectionId,
  ProviderLoginEvent,
  PublishCheckpoint,
  Repo,
  ResourceDetectionResult,
  ResourceImportResult,
  Session,
  WorkspaceConfig,
} from "@jingler/core";
import { assign, fromCallback, fromPromise, setup } from "xstate";
import { rpc } from "./rpc-client.js";

export interface AppContext {
  readonly reposDir: string | null;
  readonly repos: ReadonlyArray<Repo>;
  readonly sessions: ReadonlyArray<Session>;
  readonly providerCatalog: ProviderCatalog | null;
  readonly agentEndpointCatalog: AgentEndpointCatalog | null;
  readonly providerLoginEvent: ProviderLoginEvent | null;
  readonly providerPendingAuthKind: AuthKind | null;
  readonly resourceDetection: ResourceDetectionResult | null;
  readonly selectedResourceCandidates: ReadonlyArray<DetectedResourceCandidate>;
  readonly error: string | null;
}

export interface InitialData {
  readonly configured: boolean;
  readonly providerReady: boolean;
  readonly reposDir: string | null;
  readonly repos: ReadonlyArray<Repo>;
  readonly sessions: ReadonlyArray<Session>;
  readonly providerCatalog: ProviderCatalog;
  readonly agentEndpointCatalog?: AgentEndpointCatalog;
}

const hasSelectableDefault = (
  config: WorkspaceConfig,
  catalog: ProviderCatalog,
): boolean => {
  if (
    config.defaultConnectionId === undefined ||
    config.defaultProviderId === undefined ||
    config.defaultModelId === undefined
  ) {
    return false;
  }
  const connection = catalog.connections.find(
    (candidate) =>
      candidate.connection.id === config.defaultConnectionId &&
      candidate.connection.providerId === config.defaultProviderId,
  );
  return (
    connection?.models.some(
      (model) => model.id === config.defaultModelId && model.selectable,
    ) === true
  );
};

export interface ChosenRepositoryDirectory {
  readonly reposDir: string;
  readonly repos: ReadonlyArray<Repo>;
}

/**
 * Initial load: config + provider catalog decide setup vs. app. GitHub App state
 * has its own machine; first-run coordinates with it through explicit events.
 */
const initialLoad = fromPromise<InitialData>(async () => {
  const [config, providerCatalog, agentEndpointCatalog] = await Promise.all([
    rpc.configGet(),
    rpc.providerList(),
    rpc.agentEndpointList(),
  ]);
  if (config?.reposDir) {
    const [repos, sessions] = await Promise.all([
      rpc.workspaceRepos(),
      rpc.sessionsList(),
    ]);
    return {
      configured: true,
      providerReady:
        config.providerSetupCompleted === true ||
        hasSelectableDefault(config, providerCatalog) ||
        agentEndpointCatalog.endpoints.some(({ endpoint, models }) =>
          endpoint.status === "ready" && models.some(({ selectable }) => selectable)
        ),
      reposDir: config.reposDir,
      repos,
      sessions,
      providerCatalog,
      agentEndpointCatalog,
    };
  }
  return {
    configured: false,
    providerReady: false,
    reposDir: null,
    repos: [],
    sessions: [],
    providerCatalog,
    agentEndpointCatalog,
  };
});

/** Open the native picker, persist, and scan; null when the user cancels. */
const chooseDir = fromPromise<ChosenRepositoryDirectory | null>(async () => {
  const config = await rpc.chooseReposDir();
  if (!config?.reposDir) return null;
  const repos = await rpc.workspaceRepos();
  return { reposDir: config.reposDir, repos };
});

/** Load the persisted session list before entering the app. */
const loadSessions = fromPromise<ReadonlyArray<Session>>(async () =>
  rpc.sessionsList(),
);

export type ProviderAuthInput =
  | {
      readonly kind: "claude-setup-token";
      readonly id: string;
      readonly token: string;
      readonly targetId: string;
    }
  | {
      readonly kind: "openai-codex-oauth";
      readonly id: string;
      readonly method: CodexLoginMethod;
      readonly targetId: string;
    }
  | {
      readonly kind: "api-key";
      readonly id: string;
      readonly providerId: string;
      readonly apiKey: string;
      readonly targetId: string;
    };

const loadProviderCatalog = fromPromise<ProviderCatalog>(async () =>
  rpc.providerList(),
);

const completeProviderSetup = fromPromise<void>(async () => {
  await rpc.configCompleteProviderSetup();
});

const watchProviderLoginEvents = fromCallback<{
  readonly type: "PROVIDER_LOGIN_EVENT";
  readonly event: ProviderLoginEvent;
}>(({ sendBack }) =>
  rpc.providerLoginEvents((event) =>
    sendBack({ type: "PROVIDER_LOGIN_EVENT", event }),
  ),
);

/** Credentials are actor inputs only: XState never assigns them into persistent context. */
const connectProvider = fromPromise<ProviderConnection, ProviderAuthInput>(
  async ({ input, signal }) => {
    if (input.kind === "claude-setup-token") {
      return rpc.providerConnectClaudeToken(input);
    }
    if (input.kind === "api-key") return rpc.providerSetApiKey(input);

    let settled = false;
    const cancel = () => {
      if (!settled)
        void rpc.providerCancelLogin(input.id as ProviderConnectionId);
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      const connection = await rpc.providerStartCodexLogin(input);
      settled = true;
      return connection;
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  },
);

const detectResources = fromPromise<ResourceDetectionResult>(async () =>
  rpc.agentResourcesDetect(null),
);

const importResources = fromPromise<
  ResourceImportResult,
  ReadonlyArray<DetectedResourceCandidate>
>(async ({ input }) =>
  rpc.agentResourcesImportFiles(null, input, {
    kind: "portable",
    allowedTargets: [],
  }),
);

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export const appMachine = setup({
  types: {
    context: {} as AppContext,
    events: {} as
      | { type: "CHOOSE" }
      | { type: "CONTINUE" }
      | { type: "SKIP_GITHUB" }
      | { type: "GITHUB_CONNECTED" }
      | ({ type: "CONNECT_CLAUDE" } & Extract<
          ProviderAuthInput,
          { kind: "claude-setup-token" }
        >)
      | ({ type: "START_CODEX" } & Extract<
          ProviderAuthInput,
          { kind: "openai-codex-oauth" }
        >)
      | ({ type: "CONNECT_API" } & Extract<
          ProviderAuthInput,
          { kind: "api-key" }
        >)
      | { type: "CONTINUE_PROVIDER" }
      | { type: "SKIP_PROVIDER" }
      | { type: "CANCEL_AUTH" }
      | { type: "RETRY_AUTH" }
      | { type: "ENDPOINT_CATALOG"; catalog: AgentEndpointCatalog }
      | { type: "RETRY_PROVIDER" }
      | { type: "PROVIDER_LOGIN_EVENT"; event: ProviderLoginEvent }
      | {
          type: "IMPORT_RESOURCES";
          candidates: ReadonlyArray<DetectedResourceCandidate>;
        }
      | { type: "SKIP_RESOURCES" }
      | { type: "CANCEL_RESOURCE_IMPORT" }
      | { type: "RETRY_RESOURCES" }
      | { type: "SESSION_CREATED"; session: Session }
      | { type: "SESSION_PR_LINKED"; sessionId: string; prNumber: number }
      | {
          type: "SESSION_PUBLISH_UPDATED";
          sessionId: string;
          checkpoint: PublishCheckpoint;
        }
      | { type: "SESSION_UPDATED"; session: Session }
      | { type: "SESSION_DELETED"; sessionId: string }
      | { type: "RETRY" },
  },
  actors: {
    initialLoad,
    chooseDir,
    loadSessions,
    loadProviderCatalog,
    completeProviderSetup,
    watchProviderLoginEvents,
    connectProvider,
    detectResources,
    importResources,
  },
}).createMachine({
  id: "app",
  initial: "loading",
  context: {
    reposDir: null,
    repos: [],
    sessions: [],
    providerCatalog: null,
    agentEndpointCatalog: null,
    providerLoginEvent: null,
    providerPendingAuthKind: null,
    resourceDetection: null,
    selectedResourceCandidates: [],
    error: null,
  },
  states: {
    loading: {
      invoke: {
        src: "initialLoad",
        onDone: [
          {
            guard: ({ event }) =>
              event.output.configured && event.output.providerReady,
            target: "ready",
            actions: assign(({ event }) => ({
              reposDir: event.output.reposDir,
              repos: event.output.repos,
              sessions: event.output.sessions,
              providerCatalog: event.output.providerCatalog,
              agentEndpointCatalog: event.output.agentEndpointCatalog ?? null,
            })),
          },
          {
            guard: ({ event }) => event.output.configured,
            target: "#app.setup.provider",
            actions: assign(({ event }) => ({
              reposDir: event.output.reposDir,
              repos: event.output.repos,
              sessions: event.output.sessions,
              providerCatalog: event.output.providerCatalog,
              agentEndpointCatalog: event.output.agentEndpointCatalog ?? null,
            })),
          },
          {
            target: "setup",
            actions: assign(({ event }) => ({
              providerCatalog: event.output.providerCatalog,
              agentEndpointCatalog: event.output.agentEndpointCatalog ?? null,
            })),
          },
        ],
        onError: {
          target: "failure",
          actions: assign(({ event }) => ({ error: messageOf(event.error) })),
        },
      },
    },
    setup: {
      initial: "workspace",
      states: {
        workspace: {
          initial: "idle",
          states: {
            idle: {
              on: {
                CHOOSE: "choosing",
                CONTINUE: {
                  target: "#app.setup.github",
                  guard: ({ context }) => context.reposDir !== null,
                },
              },
            },
            choosing: {
              invoke: {
                src: "chooseDir",
                onDone: {
                  target: "idle",
                  actions: assign(({ event }) =>
                    event.output
                      ? {
                          reposDir: event.output.reposDir,
                          repos: event.output.repos,
                        }
                      : {},
                  ),
                },
                onError: {
                  target: "#app.failure",
                  actions: assign(({ event }) => ({
                    error: messageOf(event.error),
                  })),
                },
              },
            },
          },
        },
        github: {
          on: {
            GITHUB_CONNECTED: "#app.setup.provider",
            SKIP_GITHUB: "#app.setup.provider",
          },
        },
        provider: {
          initial: "refreshing",
          invoke: { src: "watchProviderLoginEvents" },
          on: {
            ENDPOINT_CATALOG: { actions: assign({ agentEndpointCatalog: ({ event }) => event.catalog }) },
            PROVIDER_LOGIN_EVENT: {
              actions: assign(({ event }) => ({
                providerLoginEvent: event.event,
              })),
            },
          },
          states: {
            refreshing: {
              invoke: {
                src: "loadProviderCatalog",
                onDone: {
                  target: "idle",
                  actions: assign(({ event }) => ({
                    providerCatalog: event.output,
                    error: null,
                  })),
                },
                onError: {
                  target: "loadFailed",
                  actions: assign(({ event }) => ({
                    error: messageOf(event.error),
                  })),
                },
              },
            },
            loadFailed: { on: { RETRY_PROVIDER: "refreshing" } },
            idle: {
              on: {
                CONTINUE_PROVIDER: {
                  target: "completing",
                  guard: ({ context }) =>
                    context.providerCatalog?.connections.some(
                      ({ connection }) => connection.status === "authenticated",
                    ) === true ||
                    context.agentEndpointCatalog?.endpoints.some(
                      ({ endpoint, models }) =>
                        endpoint.status === "ready" && models.some(({ selectable }) => selectable)
                    ) === true,
                },
                SKIP_PROVIDER: "completing",
                CONNECT_CLAUDE: {
                  target: "authenticating",
                  actions: assign({
                    providerLoginEvent: null,
                    providerPendingAuthKind: "claude-setup-token",
                    error: null,
                  }),
                },
                START_CODEX: {
                  target: "authenticating",
                  actions: assign({
                    providerLoginEvent: null,
                    providerPendingAuthKind: "openai-codex-oauth",
                    error: null,
                  }),
                },
                CONNECT_API: {
                  target: "authenticating",
                  actions: assign({
                    providerLoginEvent: null,
                    providerPendingAuthKind: "api-key",
                    error: null,
                  }),
                },
              },
            },
            completing: {
              invoke: {
                src: "completeProviderSetup",
                onDone: "#app.setup.resources",
                onError: {
                  target: "completionFailed",
                  actions: assign(({ event }) => ({
                    error: messageOf(event.error),
                  })),
                },
              },
            },
            completionFailed: {
              on: { RETRY_PROVIDER: "completing" },
            },
            authenticating: {
              invoke: {
                src: "connectProvider",
                input: ({ event }) => {
                  if (event.type === "CONNECT_CLAUDE") {
                    return {
                      kind: event.kind,
                      id: event.id,
                      token: event.token,
                      targetId: event.targetId,
                    };
                  }
                  if (event.type === "START_CODEX") {
                    return {
                      kind: event.kind,
                      id: event.id,
                      method: event.method,
                      targetId: event.targetId,
                    };
                  }
                  if (event.type === "CONNECT_API") {
                    return {
                      kind: event.kind,
                      id: event.id,
                      providerId: event.providerId,
                      apiKey: event.apiKey,
                      targetId: event.targetId,
                    };
                  }
                  throw new Error(
                    "Provider authentication requires a typed connection event.",
                  );
                },
                onDone: {
                  target: "refreshing",
                  actions: assign({ providerPendingAuthKind: null }),
                },
                onError: {
                  target: "authFailed",
                  actions: assign(({ event }) => ({
                    error: messageOf(event.error),
                    providerPendingAuthKind: null,
                  })),
                },
              },
              on: {
                CANCEL_AUTH: {
                  target: "idle",
                  actions: assign({
                    providerLoginEvent: null,
                    providerPendingAuthKind: null,
                  }),
                },
              },
            },
            authFailed: { on: { RETRY_AUTH: "idle" } },
          },
        },
        resources: {
          initial: "detecting",
          states: {
            detecting: {
              invoke: {
                src: "detectResources",
                onDone: {
                  target: "reviewing",
                  actions: assign(({ event }) => ({
                    resourceDetection: event.output,
                    selectedResourceCandidates: [],
                    error: null,
                  })),
                },
                onError: {
                  target: "detectFailed",
                  actions: assign(({ event }) => ({
                    error: messageOf(event.error),
                  })),
                },
              },
            },
            detectFailed: {
              on: {
                RETRY_RESOURCES: "detecting",
                SKIP_RESOURCES: "#app.starting",
              },
            },
            reviewing: {
              on: {
                IMPORT_RESOURCES: {
                  target: "importing",
                  actions: assign(({ event }) => ({
                    selectedResourceCandidates: event.candidates,
                    error: null,
                  })),
                },
                SKIP_RESOURCES: "#app.starting",
              },
            },
            importing: {
              invoke: {
                src: "importResources",
                input: ({ context }) => context.selectedResourceCandidates,
                onDone: "#app.starting",
                onError: {
                  target: "importFailed",
                  actions: assign(({ event }) => ({
                    error: messageOf(event.error),
                  })),
                },
              },
              on: { CANCEL_RESOURCE_IMPORT: "reviewing" },
            },
            importFailed: {
              on: {
                RETRY_RESOURCES: "importing",
                CANCEL_RESOURCE_IMPORT: "reviewing",
                SKIP_RESOURCES: "#app.starting",
              },
            },
          },
        },
      },
    },
    starting: {
      invoke: {
        src: "loadSessions",
        onDone: {
          target: "ready",
          actions: assign(({ event }) => ({ sessions: event.output })),
        },
        onError: {
          target: "failure",
          actions: assign(({ event }) => ({ error: messageOf(event.error) })),
        },
      },
    },
    ready: {
      on: {
        SESSION_CREATED: {
          actions: assign(({ context, event }) => ({
            sessions: [event.session, ...context.sessions],
          })),
        },
        // A PR was created/detected for a session — reflect its number so the
        // sidebar badge and the Pull Request / Code Review tabs light up.
        SESSION_PR_LINKED: {
          actions: assign(({ context, event }) => ({
            sessions: context.sessions.map((s) =>
              s.id === event.sessionId ? { ...s, prNumber: event.prNumber } : s,
            ),
          })),
        },
        // Merge the streamed checkpoint instead of replacing the whole session
        // with a stale snapshot while title/status writes may be concurrent.
        SESSION_PUBLISH_UPDATED: {
          actions: assign(({ context, event }) => ({
            sessions: context.sessions.map((session) =>
              session.id === event.sessionId
                ? {
                    ...session,
                    publish: event.checkpoint,
                    ...(event.checkpoint.step === "complete" &&
                    event.checkpoint.prNumber !== undefined
                      ? { prNumber: event.checkpoint.prNumber }
                      : {}),
                  }
                : session,
            ),
          })),
        },
        // Upsert a session written outside this machine. Most callers replace an
        // existing record, while cross-environment continuation publishes a new
        // session through the same one-way update channel.
        SESSION_UPDATED: {
          actions: assign(({ context, event }) => {
            const exists = context.sessions.some(
              (session) => session.id === event.session.id,
            );
            return {
              sessions: exists
                ? context.sessions.map((session) =>
                    session.id === event.session.id ? event.session : session,
                  )
                : [...context.sessions, event.session],
            };
          }),
        },
        // Drop a permanently-deleted session from the list.
        SESSION_DELETED: {
          actions: assign(({ context, event }) => ({
            sessions: context.sessions.filter((s) => s.id !== event.sessionId),
          })),
        },
      },
    },
    failure: {
      on: { RETRY: "loading" },
    },
  },
});
