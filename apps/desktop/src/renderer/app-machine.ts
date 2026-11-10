/**
 * The renderer's top-level state machine. Modelling the first-run/loading/ready
 * flow as an XState chart keeps every async transition (initial load, folder
 * pick + scan, session load) inside declarative `fromPromise` actors — no
 * data-fetching `useEffect`s, minimal `useState`.
 */
import type {
  AgentEndpointCatalog,
  ProviderCatalog,
  PublishCheckpoint,
  Repo,
  Session,
  WorkspaceConfig,
} from "@jingler/core";
import { activeCheckoutOf, reduceCheckouts, type SessionCheckout } from "@jingler/core";
import { assign, fromPromise, setup } from "xstate";
import { rpc } from "./rpc-client.js";

const editActiveCheckout = (session: Session, patch: Partial<Omit<SessionCheckout, "id">>): Session =>
  reduceCheckouts(session, { type: "update", checkoutId: activeCheckoutOf(session).id, patch });

export interface AppContext {
  readonly reposDir: string | null;
  readonly repos: ReadonlyArray<Repo>;
  readonly sessions: ReadonlyArray<Session>;
  readonly providerCatalog: ProviderCatalog | null;
  readonly agentEndpointCatalog: AgentEndpointCatalog | null;
  /** Paths of the scanned repositories ticked on onboarding step 1. */
  readonly selectedRepoPaths: ReadonlyArray<string>;
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

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

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

const scanFailure = (dir: string, reason: string) =>
  new Error(`Couldn't read ${dir}, ${reason}`);

/**
 * Open the native picker, persist, and scan; null when the user cancels. The
 * workspace scan swallows unreadable folders as "no repos", so readability is
 * checked first to surface a real error on step 1.
 */
const chooseDir = fromPromise<ChosenRepositoryDirectory | null>(async () => {
  const config = await rpc.chooseReposDir();
  if (!config?.reposDir) return null;
  const { reposDir } = config;
  await rpc.projectsListDirectories(reposDir).catch(() => {
    throw scanFailure(reposDir, "permission denied");
  });
  const repos = await rpc.workspaceRepos().catch((error: unknown) => {
    throw scanFailure(reposDir, messageOf(error));
  });
  return { reposDir, repos };
});

/** Register exactly the repositories the user ticked on step 1. */
const registerProjects = fromPromise<void, ReadonlyArray<string>>(
  async ({ input }) => {
    for (const path of input) {
      // Sequential: registration persists to a single projects file.
      // eslint-disable-next-line no-await-in-loop
      await rpc.projectsRegister({ path });
    }
  },
);

/** Load the persisted session list before entering the app. */
const loadSessions = fromPromise<ReadonlyArray<Session>>(async () =>
  rpc.sessionsList(),
);

const loadProviderCatalog = fromPromise<ProviderCatalog>(async () =>
  rpc.providerList(),
);

const completeProviderSetup = fromPromise<void>(async () => {
  await rpc.configCompleteProviderSetup();
});

export const appMachine = setup({
  types: {
    context: {} as AppContext,
    events: {} as
      | { type: "CHOOSE" }
      | { type: "CONTINUE" }
      | { type: "TOGGLE_REPO"; path: string }
      | { type: "TOGGLE_ALL_REPOS" }
      | { type: "ADD_PROJECTS" }
      | { type: "SKIP_GITHUB" }
      | { type: "GITHUB_CONNECTED" }
      | { type: "CONTINUE_PROVIDER" }
      | { type: "SKIP_PROVIDER" }
      | { type: "PROVIDER_CONNECTED" }
      | { type: "ENDPOINT_CATALOG"; catalog: AgentEndpointCatalog }
      | { type: "RETRY_PROVIDER" }
      | { type: "SKIP_IMPORT_SESSIONS" }
      | { type: "CONTINUE_IMPORT_SESSIONS" }
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
    registerProjects,
    loadSessions,
    loadProviderCatalog,
    completeProviderSetup,
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
    selectedRepoPaths: [],
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
                CHOOSE: { target: "choosing", actions: assign({ error: null }) },
                CONTINUE: {
                  target: "#app.setup.github",
                  guard: ({ context }) => context.reposDir !== null,
                  actions: assign({ error: null }),
                },
                TOGGLE_REPO: {
                  actions: assign({
                    selectedRepoPaths: ({ context, event }) =>
                      context.selectedRepoPaths.includes(event.path)
                        ? context.selectedRepoPaths.filter(
                            (path) => path !== event.path,
                          )
                        : [...context.selectedRepoPaths, event.path],
                  }),
                },
                TOGGLE_ALL_REPOS: {
                  actions: assign({
                    selectedRepoPaths: ({ context }) =>
                      context.selectedRepoPaths.length === context.repos.length
                        ? []
                        : context.repos.map((repo) => repo.path),
                  }),
                },
                ADD_PROJECTS: {
                  target: "registering",
                  guard: ({ context }) =>
                    context.reposDir !== null &&
                    context.selectedRepoPaths.length > 0,
                  actions: assign({ error: null }),
                },
              },
            },
            registering: {
              invoke: {
                src: "registerProjects",
                input: ({ context }) => context.selectedRepoPaths,
                onDone: "#app.setup.github",
                // A failed registration keeps the user on step 1 to retry.
                onError: {
                  target: "idle",
                  actions: assign(({ event }) => ({
                    error: `Couldn't add projects, ${messageOf(event.error)}`,
                  })),
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
                          selectedRepoPaths: [],
                        }
                      : {},
                  ),
                },
                // A failed scan keeps onboarding alive: stay on step 1 with the
                // error so the user can retry or pick another folder.
                onError: {
                  target: "idle",
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
          on: {
            ENDPOINT_CATALOG: { actions: assign({ agentEndpointCatalog: ({ event }) => event.catalog }) },
            PROVIDER_CONNECTED: ".refreshing",
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
              },
            },
            completing: {
              invoke: {
                src: "completeProviderSetup",
                onDone: "#app.setup.importSessions",
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
          },
        },
        importSessions: {
          initial: "idle",
          states: {
            idle: {
              on: {
                SKIP_IMPORT_SESSIONS: "#app.starting",
                CONTINUE_IMPORT_SESSIONS: "#app.starting",
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
              s.id === event.sessionId ? editActiveCheckout(s, { prNumber: event.prNumber, prs: [{ number: event.prNumber }] }) : s,
            ),
          })),
        },
        // Merge the streamed checkpoint instead of replacing the whole session
        // with a stale snapshot while title/status writes may be concurrent.
        SESSION_PUBLISH_UPDATED: {
          actions: assign(({ context, event }) => ({
            sessions: context.sessions.map((session) =>
              session.id === event.sessionId
                ? editActiveCheckout(session, {
                    publish: event.checkpoint,
                    ...(event.checkpoint.step === "complete" &&
                    event.checkpoint.prNumber !== undefined
                      ? { prNumber: event.checkpoint.prNumber, prs: [{ number: event.checkpoint.prNumber }] }
                      : {}),
                  })
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
                    session.id === event.session.id
                      ? {
                          ...event.session,
                          // RPC replies can arrive after setup has finished.
                          // Lifecycle timestamps belong to the durable workflow,
                          // independently of status/title and other session writes.
                          // No writer clears lifecycle; omission is a legacy reply.
                          ...(session.workspaceLifecycle &&
                          (!event.session.workspaceLifecycle ||
                            Date.parse(session.workspaceLifecycle.updatedAt) >
                              Date.parse(event.session.workspaceLifecycle.updatedAt))
                            ? {
                                workspaceLifecycle: session.workspaceLifecycle,
                                archived: session.archived,
                                archiveReason: session.archiveReason,
                                archivedAt: session.archivedAt,
                              }
                            : {}),
                        }
                      : session,
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
