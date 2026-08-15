import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { expect, test as base } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { startFakeAuthServer, type FakeAuthServer } from "./fake-auth.js";
import {
  startFakeGitHubServer,
  type FakeGitHubOptions,
  type FakeGitHubServer,
} from "./fake-github.js";
import {
  startFakeGitHubRelay,
  type FakeGitHubRelay,
} from "./fake-github-relay.js";
import {
  startFakeDeviceRelay,
  type FakeDeviceRelay,
} from "./fake-device-relay.js";
import { installFakeSshHost } from "./fake-ssh-host.js";
import {
  DEVICE_AGENT_ARCHIVE,
  DEVICE_AGENT_ENTRY,
  MAIN_ENTRY
} from "./global-setup.js";
import type { Chat, RuntimeRecoveryState } from "@jingler/core";
import {
  E2E_PI_CONNECTION_ID,
  E2E_PI_MODEL_ID,
  E2E_PI_PROVIDER_ID,
} from "../src/main/e2e/fixture-identity.js";

/** Match PlanStore's collision-proof directory for one physical checkout. */
export const planDirectory = (home: string, worktreePath: string): string => {
  let canonical: string;
  try {
    canonical = realpathSync(worktreePath);
  } catch {
    canonical = resolve(worktreePath);
  }
  const suffix = createHash("sha256")
    .update(canonical)
    .digest("hex")
    .slice(0, 12);
  return join(home, "jingler", ".jingler", `${basename(canonical)}-${suffix}`);
};

/**
 * Put the sidebar's Status filter on `archived` (or `all`) so archived sessions
 * are listed at all.
 *
 * They used to live in a permanent "Archived" group pinned to the bottom of the
 * sidebar. That group is gone: archived is a FILTER now, and the default hides it
 * (see `session-filters.ts` — "one model, and the default hides them"). Specs
 * written against the old group had been asserting on a heading that no longer
 * exists, which reads as "archiving is broken" when it is working exactly as
 * designed. Going through the real menu also tests the route a user actually has.
 */
export const showSessions = async (
  window: Page,
  status: "Active" | "Archived" | "All",
): Promise<void> => {
  await window.getByTestId("session-filter-menu").click();
  // Both rows are matched by PREFIX, never exactly: the axis trigger appends the
  // current value ("Status Active") so it can state the filter while shut, and
  // each option appends its match count ("Archived 1"). An exact matcher finds
  // neither.
  await window.getByRole("menuitem", { name: /^Status/ }).click();
  await window
    .getByRole("menuitem", { name: new RegExp(`^${status}`) })
    .click();
  // Close the menu so it cannot sit over the rows the caller is about to assert on.
  await window.keyboard.press("Escape");
  await expect(window.getByTestId("session-filter-menu")).toBeVisible();
};

/**
 * "The app shell is on screen" — the sentinel ~19 specs assert before doing
 * anything else.
 *
 * It used to be `getByText("Sessions", { exact: true })`, repeated 56 times. The
 * sidebar header then merged into one row and lost that label, and every one of
 * those specs failed at once for a reason that had nothing to do with what they
 * were testing.
 *
 * The search field is a better sentinel than a heading anyway: it is a control
 * the operator uses rather than decoration, so it is far less likely to be
 * restyled away — and if it ever is, this is one line rather than fifty-six.
 *
 * That prediction was half right. The sidebar's "Filter sessions…" field WAS
 * removed — search went global and moved to the title bar — and this being one
 * line is the only reason the whole suite did not fail with it. The sentinel is
 * now the title bar's search control, found by its accessible name rather than
 * by a placeholder: it is a button dressed as a field (it opens the command
 * palette rather than accepting text), so `getByPlaceholder` has nothing to
 * match and the label is the stabler handle regardless.
 */
export const appShell = (window: Page) =>
  window.getByRole("button", { name: "Search sessions and actions" });

/** Create a normal workspace through the current project-scoped composer. */
export const createWorkspace = async (
  window: Page,
  _taskDescription: string,
  checkout: "worktree" | "direct" = "worktree",
): Promise<void> => {
  await window.getByTestId("new-session").click();
  await expect(
    window.getByRole("heading", { name: "New session" }),
  ).toBeVisible();
  if (checkout === "direct") {
    await window.getByRole("button", { name: "Checkout" }).click();
    await window.getByRole("option", { name: "Local" }).click();
  }
  const create = window.getByRole("button", { name: "Create workspace" });
  await expect(create).toBeEnabled();
  await create.click();
};

/**
 * The SIDEBAR row for a session, found by its title.
 *
 * ## Why `getByText(title)` stopped working
 *
 * The tab-chrome redesign folded the Conversation tab into a chip that wears the
 * session's name. So an OPEN session's title is now on screen twice — once in the
 * sidebar row, once in its pane's header — and `getByText("Alpha session")`
 * resolves to two elements, which Playwright's strict mode treats as an error
 * rather than picking one.
 *
 * Every spec that clicked a session by its title broke at once, and the fix is not
 * "pick the first": the two elements do different jobs, and a spec that means
 * "switch to this session" wants the sidebar unambiguously.
 *
 * ## Why by title rather than by id
 *
 * `session-row-<id>` is the canonical handle and is what a spec should use when it
 * has the id to hand. This exists for the many call sites that only ever knew the
 * title — converting those to ids means threading a constant through each spec for
 * no gain, while a prefix locator filtered by text is exact enough: the prefix
 * confines it to the sidebar list, and the title picks the row.
 */
export const sessionRow = (window: Page, title: string) =>
  window.locator("[data-testid^='session-row-']").filter({ hasText: title });

/**
 * Click a session in the sidebar. The common case of {@link sessionRow}.
 *
 * `.first()` is safe HERE and not a fudge: the locator is already confined to the
 * sidebar, so more than one match means two sessions share a title — and clicking
 * either satisfies what such a spec asked for.
 */
export const openSessionByTitle = async (
  window: Page,
  title: string,
): Promise<void> => {
  await sessionRow(window, title).first().click();
};

/** A seeded session written to sessions.json (valid `Session` shape). */
export interface SeedSession {
  readonly id: string;
  readonly repo: string;
  readonly branch: string;
  readonly title: string;
  readonly status: "idle" | "running" | "thinking" | "needs-input" | "done";
  readonly executionLocation?: "local" | "cloud";
  readonly environmentId?: string;
  readonly diff: { added: number; removed: number };
  readonly prNumber: number | null;
  readonly githubInstallationId?: string;
  readonly githubRepositoryId?: string;
  readonly githubFeedbackDeliveryIds?: ReadonlyArray<string>;
  readonly githubFeedbackSemanticKeys?: ReadonlyArray<string>;
  readonly issueNumber?: number | null;
  readonly costUsd: number;
  readonly tokens: number;
  readonly contextTokens?: number;
  readonly updatedAt: string;
  readonly worktreePath?: string;
  /**
   * The repo's absolute path. Distinct from `repo`, which is only the display
   * name — the two disagree exactly when the directory has been renamed since
   * the session was created, which is what `migrateRepoName` exists to fix.
   */
  readonly repoPath?: string;
  readonly baseBranch?: string;
  readonly connectionId?: string;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly piSessionId?: string;
  readonly modelSelectionRequired?: boolean;
  readonly connectionSelectionRequired?: boolean;
  readonly runtimeRecovery?: RuntimeRecoveryState;
  readonly mode?: "ask" | "accept-edits" | "auto";
  readonly archived?: boolean;
  readonly archiveReason?: "merged" | "closed";
  readonly archivedAt?: string;
  readonly persistent?: boolean;
  readonly workspaceMode?: "worktree" | "direct";
  readonly chats?: ReadonlyArray<Chat>;
  readonly activeChatId?: string;
}

const withCanonicalRuntimeIdentity = (session: SeedSession): SeedSession => {
  const identity =
    session.connectionSelectionRequired === true ||
    session.modelSelectionRequired === true
      ? {}
      : {
          connectionId: E2E_PI_CONNECTION_ID,
          providerId: E2E_PI_PROVIDER_ID,
          modelId: E2E_PI_MODEL_ID,
        };
  const chatDefaults = session.mode === undefined ? {} : { mode: session.mode };
  const chats = session.chats?.map((chat) => ({
    ...identity,
    ...chatDefaults,
    ...chat,
  })) ?? [
    {
      id: `c_${session.id}_1`,
      title: null,
      createdAt: session.updatedAt,
      updatedAt: session.updatedAt,
      ...identity,
      ...chatDefaults,
    },
  ];
  return {
    ...identity,
    ...session,
    chats,
    activeChatId: session.activeChatId ?? chats[0]!.id,
  };
};

export interface LaunchOptions {
  /**
   * Seed a deterministic pi transport script. The production PiAgentRuntime,
   * auth broker, tool registry and diff tracker consume this transport; tests
   * do not replace those layers with the legacy scripted adapter.
   */
  readonly piFixture?: {
    readonly scenarioId: string;
    readonly authRoute: "claude-setup-token" | "openai-codex-oauth" | "api-key";
    readonly reasoning?: ReadonlyArray<
      "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
    >;
    readonly seedConnection?: boolean;
    readonly modelCount?: number;
  };
  /**
   * Relaunch against an EXISTING `~/jingler` (a previous launch's `home`) —
   * i.e. a real app restart, reading whatever the last run persisted rather than
   * what the test seeded. Pass `reposDir` alongside it to keep the same repos.
   * The original launch still owns teardown for both.
   */
  readonly home?: string;
  /** Reuse a previous launch's repos dir; pair with `home` for a restart. */
  readonly reposDir?: string;
  /**
   * Reuse a previous launch's Chromium profile, so `localStorage` survives the
   * restart too. `home` alone restarts the app's JSON state but hands it a FRESH
   * profile — which silently resets anything stored in localStorage (panel
   * widths, dock sides, the session grid layout). Pass this alongside `home`
   * when the thing under test is one of those. The original launch still owns
   * teardown.
   */
  readonly userDataDir?: string;
  /**
   * Point the launched process's home-directory discovery at this launch's
   * throwaway home. Use when testing imports from ~/.agents, ~/.claude, or
   * similar roots without reading or mutating the developer's real files.
   */
  readonly isolateSystemHome?: boolean;
  /** Seed config.json so the app boots configured (past first-run). */
  readonly configured?: boolean;
  /** Additional persisted workspace config for settings/routing scenarios. */
  readonly config?: Readonly<Record<string, unknown>>;
  /** Create a real git repo in the seeded repos dir (for the create-session flow). */
  readonly withRepo?: boolean;
  /** Seed the default repository on the fake remote host (defaults to true). */
  readonly remoteRepo?: boolean;
  /**
   * Seed sessions.json — either a fixed list, or a function of the launch context
   * (so a session's `worktreePath` can point at the just-created repo).
   */
  readonly sessions?:
    | ReadonlyArray<SeedSession>
    | ((ctx: {
        reposDir: string;
        repoPath: string;
      }) => ReadonlyArray<SeedSession>);
  /**
   * Seed persisted transcripts, keyed by session id → the message array written to
   * `~/jingler/transcripts/<id>.json`. Lets a test load a conversation with, e.g.,
   * an orphaned pending gate (to assert it settles on load).
   */
  readonly transcripts?: Record<string, ReadonlyArray<unknown>>;
  /**
   * Seed a finished reviewer's event stream, keyed by session id → the events
   * written to `~/jingler/reviews/<id>.transcript.json`. A fresh launch with one
   * of these IS the "restored after a restart" case: the app has no live reviewer,
   * so a Reviewer tab can only come from the disk.
   */
  readonly reviewTranscripts?: Record<string, ReadonlyArray<unknown>>;
  /** Seed extra fixtures (e.g. project skills) after repo creation, before launch. */
  readonly seed?: (ctx: {
    home: string;
    reposDir: string;
    repoPath: string;
  }) => void;
  /**
   * Whether to boot past the sign-in wall (default true). When true the fixture
   * seeds a valid token so the app lands signed in; set false to assert the wall
   * itself (auth.spec).
   */
  readonly signedIn?: boolean;
  /**
   * Replace only the product Better Auth session boundary. This lets a test use
   * Better Auth's official test account while the existing offline server keeps
   * supplying unrelated memory/environment fixtures. The caller owns teardown.
   */
  readonly authSessionServer?: {
    readonly url: string;
    readonly token: string;
  };
  /**
   * Reuse one stateful offline auth/MCP/memory fake across several launches.
   * This is the teammate and organization-isolation boundary: accepted state
   * survives app instances, while each launch still has isolated local files.
   * The caller owns the supplied server and closes it after the scenario.
   */
  readonly authServer?: FakeAuthServer;
  /** Initial state for the offline shared GitHub App API. */
  readonly githubApp?: FakeGitHubOptions;
  /** Reuse a stateful fake GitHub API across app restarts. */
  readonly githubServer?: FakeGitHubServer;
  /** Reuse a stateful relay across app restarts. */
  readonly githubRelay?: FakeGitHubRelay;
  /** Test-only process flags for forcing a precise persistence/crash boundary. */
  readonly e2eEnv?: Readonly<Record<string, string>>;
  /**
   * Start the hermetic buildbox relay + real bundled device-agent process.
   * No user SSH files, credentials, ports, or home directories are consulted.
   */
  readonly remoteEnvironment?: boolean;
  /**
   * Opt-in physical-host QA. The app still uses the offline auth/relay fixture,
   * but SSH, the uploaded bundle, discovery, and session execution happen on
   * the named machine. Never set this in routine or CI runs.
   */
  readonly realRemoteEnvironment?: {
    readonly host: string;
    readonly username: string;
    readonly identityFile: string;
    readonly relayHost: string;
  };
}

const DEFAULT_PI_FIXTURE: NonNullable<LaunchOptions["piFixture"]> = {
  scenarioId: "default",
  authRoute: "api-key",
  reasoning: ["low", "medium", "high"],
};

export interface LaunchedApp {
  readonly app: ElectronApplication;
  readonly window: Page;
  /** The throwaway home; `~/jingler` lives at `<home>/jingler`. */
  readonly home: string;
  /** The seeded repos directory (when `configured`). */
  readonly reposDir: string;
  /**
   * This launch's Chromium profile. Pass it back as `userDataDir` on a restart
   * to carry `localStorage` across — panel widths, dock sides, the grid layout.
   */
  readonly userDataDir: string;
  /** The seeded repo's path (when `withRepo`). */
  readonly repoPath: string;
  /** The offline fake auth backend this launch talks to. */
  readonly authServer: FakeAuthServer;
  /** Stateful GitHub App fake used by the real main-process HTTP bridge. */
  readonly githubServer: FakeGitHubServer;
  /** Authenticated reconnectable websocket relay used by realtime-feedback specs. */
  readonly githubRelay: FakeGitHubRelay;
  /** Present only for a launch using the hermetic remote-environment fixture. */
  readonly deviceRelay?: FakeDeviceRelay;
  /** Throwaway home used by the hermetic remote device agent. */
  readonly deviceHome?: string;
  /**
   * Drive a `jingler://` sign-in callback into the running app (the OS would
   * normally do this after the browser flow). Emits the main-process `open-url`.
   */
  readonly completeDeepLinkSignIn: () => Promise<void>;
  /** Complete GitHub installation and emit its dedicated desktop callback. */
  readonly completeGitHubConnection: () => Promise<void>;
  /** Semantic GitHub writes observed by the fake API server. */
  readonly githubOperations: () => ReadonlyArray<string>;
}

const git = (cwd: string, args: ReadonlyArray<string>) =>
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });

const initRepo = (dir: string): void => {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "e2e@jingler.dev"]);
  git(dir, ["config", "user.name", "Jingler E2E"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(dir, "README.md"), "# e2e repo\n");
  git(dir, ["add", "-A"]);
  execFileSync("git", ["commit", "-m", "init", "--no-gpg-sign"], {
    cwd: dir,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z"
    },
  });
};

export const test = base.extend<{
  launchApp: (options?: LaunchOptions) => Promise<LaunchedApp>;
}>({
  // The first argument is Playwright's fixture bag, which this fixture uses none
  // of — but it has to be there for `use` to be the second parameter.
  // biome-ignore lint/correctness/noEmptyPattern: required by Playwright's signature
  launchApp: async ({}, use) => {
    const cleanups: Array<() => void | Promise<void>> = [];
    const apps: ElectronApplication[] = [];

    const launch = async (
      options: LaunchOptions = {},
    ): Promise<LaunchedApp> => {
      // Reusing a previous launch's `home`/`reposDir` is what makes a REAL
      // restart testable: the second launch reads the state the first one wrote,
      // rather than state the test seeded. Without it, "survives a restart" can
      // only ever assert that seeded fixtures render. Skip re-registering
      // cleanups so the first launch's teardown isn't run twice.
      const reused = options.home !== undefined;
      const home =
        options.home ?? mkdtempSync(join(tmpdir(), "jingler-e2e-home-"));
      const jinglerDir = join(home, "jingler");
      const reposDir =
        options.reposDir ?? mkdtempSync(join(tmpdir(), "jingler-e2e-repos-"));
      const piFixture = options.piFixture ?? DEFAULT_PI_FIXTURE;
      if (!reused) {
        cleanups.push(() => rmSync(home, { recursive: true, force: true }));
        cleanups.push(() => rmSync(reposDir, { recursive: true, force: true }));
      }

      let repoPath = "";
      if (options.withRepo) {
        repoPath = join(reposDir, "widget");
        // A reused home already has its repo; re-initialising would wipe it.
        if (!existsSync(repoPath)) initRepo(repoPath);
      }

      /**
       * Seed config.json — but NEVER over a reused home's existing one.
       *
       * A restart (`home` + `configured`) is supposed to read what the previous
       * launch persisted. Re-seeding threw that away silently: settings the app
       * wrote (a managed-resource toggle, say) vanished, and the spec read the
       * absence as "it didn't persist" rather than "the fixture deleted it".
       */
      const configPath = join(jinglerDir, "config.json");
      if (options.configured && !(reused && existsSync(configPath))) {
        mkdirSync(jinglerDir, { recursive: true });
        writeFileSync(
          configPath,
          JSON.stringify(
            {
              reposDir,
              createdAt: "2026-07-11T00:00:00.000Z",
              ...(piFixture.seedConnection === false
                ? {}
                : {
                    defaultConnectionId: E2E_PI_CONNECTION_ID,
                    defaultProviderId: E2E_PI_PROVIDER_ID,
                    defaultModelId: E2E_PI_MODEL_ID,
                    connectionSelectionRequired: false,
                  }),
              ...options.config,
            },
            null,
            2,
          ),
        );
      }
      if (options.sessions) {
        const sessions =
          typeof options.sessions === "function"
            ? options.sessions({ reposDir, repoPath })
            : options.sessions;
        mkdirSync(jinglerDir, { recursive: true });
        writeFileSync(
          join(jinglerDir, "sessions.json"),
          JSON.stringify(sessions.map(withCanonicalRuntimeIdentity), null, 2),
        );
      }
      if (options.transcripts) {
        const dir = join(jinglerDir, "transcripts");
        mkdirSync(dir, { recursive: true });
        for (const [sessionId, messages] of Object.entries(
          options.transcripts,
        )) {
          writeFileSync(
            join(dir, `${sessionId}.json`),
            JSON.stringify(messages, null, 2),
          );
        }
      }
      if (options.reviewTranscripts) {
        const dir = join(jinglerDir, "reviews");
        mkdirSync(dir, { recursive: true });
        for (const [sessionId, events] of Object.entries(
          options.reviewTranscripts,
        )) {
          writeFileSync(
            join(dir, `${sessionId}.transcript.json`),
            JSON.stringify(events),
          );
        }
      }

      // Seed extra fixtures (e.g. project skills) before launch, so they exist
      // when the app first scans them.
      options.seed?.({ home, reposDir, repoPath });

      const piFixtureFile = join(jinglerDir, "e2e-pi-fixture.json");
      if (!(
        reused &&
        options.piFixture === undefined &&
        existsSync(piFixtureFile)
      )) {
        mkdirSync(jinglerDir, { recursive: true });
        writeFileSync(piFixtureFile, JSON.stringify(piFixture, null, 2));
      }

      const binDir = join(home, "bin");
      mkdirSync(binDir, { recursive: true });
      // A connected App fixture needs an origin for immutable repository
      // resolution and API-driven checkout.
      if (options.githubApp?.connected && repoPath) {
        const remotes = execFileSync("git", ["remote"], {
          cwd: repoPath,
          encoding: "utf8",
        }).trim();
        if (!remotes.split("\n").includes("origin")) {
          git(repoPath, [
            "remote",
            "add",
            "origin",
            "git@github.com:acme/widget.git",
          ]);
        }
        for (const pr of options.githubApp.prs ?? []) {
          git(repoPath, ["branch", "--force", pr.headRefName, "main"]);
        }
      }

      let deviceRelay: FakeDeviceRelay | undefined;
      let deviceHome: string | undefined;
      if (options.remoteEnvironment || options.realRemoteEnvironment) {
        deviceHome = mkdtempSync(join(tmpdir(), "jingler-e2e-device-"));
        cleanups.push(() =>
          rmSync(deviceHome, { recursive: true, force: true }),
        );
        const deviceRepo = join(deviceHome, "repos", "widget");
        mkdirSync(join(deviceHome, "repos"), { recursive: true });
        if (options.remoteRepo !== false) initRepo(deviceRepo);
        mkdirSync(join(deviceHome, "jingler"), { recursive: true });
        writeFileSync(
          join(deviceHome, "jingler", "config.json"),
          JSON.stringify(
            {
              reposDir: join(deviceHome, "repos"),
              createdAt: "2026-08-08T00:00:00.000Z",
            },
            null,
            2,
          ),
        );
        deviceRelay = await startFakeDeviceRelay({
          deviceAgentBundle: DEVICE_AGENT_ENTRY,
          deviceHome,
          deviceBinDir: binDir,
          piFixture: {
            file: piFixtureFile,
            connectionId: E2E_PI_CONNECTION_ID,
            providerId: E2E_PI_PROVIDER_ID,
            modelId: E2E_PI_MODEL_ID,
          },
          spawnAgentOnClaim: options.realRemoteEnvironment === undefined,
          ...(options.realRemoteEnvironment
            ? {
                listenHost: "0.0.0.0",
                publicHost: options.realRemoteEnvironment.relayHost,
              }
            : {}),
        });
        cleanups.push(() => deviceRelay?.close());
        if (options.realRemoteEnvironment) {
          const target = options.realRemoteEnvironment;
          const sshDir = join(home, ".ssh");
          mkdirSync(sshDir, { recursive: true, mode: 0o700 });
          const quotedIdentity = target.identityFile.replaceAll('"', '\\"');
          writeFileSync(
            join(sshDir, "config"),
            `Host ${target.host}\n  HostName ${target.host}\n  User ${target.username}\n  IdentityFile "${quotedIdentity}"\n  IdentitiesOnly yes\n`,
            { mode: 0o600 },
          );
          const hostKeys = execFileSync(
            "/usr/bin/ssh-keyscan",
            ["-T", "5", target.host],
            {
              encoding: "utf8",
              stdio: ["ignore", "pipe", "ignore"],
            },
          );
          writeFileSync(join(sshDir, "known_hosts"), hostKeys, { mode: 0o600 });
        } else {
          installFakeSshHost({
            binDir,
            desktopHome: home,
            deviceHome,
            deviceAgentBundle: DEVICE_AGENT_ENTRY,
            relayUrl: deviceRelay.url,
          });
        }
      }

      // Offline auth backend. Signed-in by default: seed the token file that the
      // e2e plaintext SecretStore reads, so the app boots past the wall.
      const authServer =
        options.authServer ??
        (await startFakeAuthServer(
          deviceRelay
            ? {
                deviceRelayUrl: deviceRelay.url,
                ...(options.realRemoteEnvironment
                  ? {
                      listenHost: "0.0.0.0",
                      publicHost: options.realRemoteEnvironment.relayHost,
                    }
                  : {}),
              }
            : {},
        ));
      if (options.authServer === undefined) {
        cleanups.push(() => {
          authServer.close().catch(() => {});
        });
      }
      const signedIn = options.signedIn ?? true;
      const authSessionServer = options.authSessionServer ?? authServer;
      if (signedIn) {
        mkdirSync(jinglerDir, { recursive: true });
        writeFileSync(
          join(jinglerDir, "auth.enc"),
          deviceRelay?.token ?? authSessionServer.token,
        );
      }

      const githubRelay = options.githubRelay ?? (await startFakeGitHubRelay());
      if (options.githubRelay === undefined) {
        cleanups.push(() => {
          githubRelay.close().catch(() => {});
        });
      }

      const githubServer =
        options.githubServer ??
        (await startFakeGitHubServer(authServer.token, {
          ...options.githubApp,
          relayUrl: githubRelay.url,
          relayGrant: githubRelay.grant,
          // A native App fixture normally resolves PR heads from the repository
          // created for this launch. Callers can still supply a fork checkout.
          ...(repoPath && options.githubApp?.cloneUrl === undefined
            ? { cloneUrl: repoPath }
            : {}),
        }));
      if (options.githubServer === undefined) {
        cleanups.push(() => {
          githubServer.close().catch(() => {});
        });
      }

      // A throwaway Chromium profile per launch. `JINGLER_HOME` isolates the
      // app's own JSON state, but NOT `localStorage` — which lives in Electron's
      // userData dir and backs the renderer's UI chrome prefs (browser-preview
      // visibility + dock side, panel widths). Without this the default profile is
      // shared by every test AND every run, so `previews.spec.ts` opening the
      // preview leaked into later tests forever: at the 1320px default window the
      // extra rail squeezed the Plan Review step spec to zero width, and its
      // assertions failed on an element that was rendered but had no box.
      const userDataDir =
        options.userDataDir ??
        mkdtempSync(join(tmpdir(), "jingler-e2e-userdata-"));
      // Only the launch that CREATED the profile tears it down, or a restart
      // would delete the directory its predecessor is still cleaning up.
      if (!options.userDataDir) {
        cleanups.push(() =>
          rmSync(userDataDir, { recursive: true, force: true }),
        );
      }

      const app = await electron.launch({
        args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
        env: {
          ...process.env,
          // Run every built-app scenario against the same clean-machine
          // boundary: embedded pi, Electron/Node, and system git. Never inherit
          // the developer's PATH. In particular, a locally installed
          // GitHub CLI must not hide a built-in regression back to `gh`.
          PATH: `${binDir}:${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
          ...(options.isolateSystemHome ? { HOME: home } : {}),
          JINGLER_HOME: home,
          ELECTRON_RENDERER_URL: "",
          // Auth: talk to the offline fake backend, and store the token as a plain
          // file (no OS keychain prompts under headless Playwright).
          JINGLER_AUTH_URL: authSessionServer.url,
          ...(deviceRelay
            ? {
                JINGLER_DEVICE_RELAY_URL: deviceRelay.url,
                JINGLER_DEVICE_AGENT_BUNDLE: DEVICE_AGENT_ARCHIVE,
                JINGLER_SSH_DIR: join(home, ".ssh"),
                JINGLER_E2E_SSH_LOG: join(home, "ssh-invocations.jsonl"),
              }
            : {}),
          JINGLER_GITHUB_URL: githubServer.url,
          JINGLER_GITHUB_API_URL: githubServer.url,
          JINGLER_SECRET_STORE: "memory",
          JINGLER_E2E_PI_FIXTURE: piFixtureFile,
          JINGLER_E2E: "1",
          // Keep the window hidden and off the dock. The suite launches a real
          // Electron app dozens of times, and a visible window steals focus on
          // every launch — which makes running the suite locally (its only home;
          // it's not in CI) incompatible with using the machine at the same time.
          // Set JINGLER_E2E_HEADED=1 to watch a run instead.
          JINGLER_E2E_HEADLESS:
            process.env.JINGLER_E2E_HEADED === "1" ? "0" : "1",
          ...options.e2eEnv,
        },
      });
      apps.push(app);
      app.on("window", (page) => {
        page.on("pageerror", (error) =>
          console.error("E2E_RENDERER_ERROR", error),
        );
        page.on("console", (message) => {
          if (message.type() === "error")
            console.error("E2E_RENDERER_CONSOLE", message.text());
        });
      });
      const window = await app.firstWindow();
      await window.waitForLoadState("domcontentloaded");

      const completeDeepLinkSignIn = async () => {
        await app.evaluate(({ app: electronApp }, url) => {
          electronApp.emit("open-url", { preventDefault() {} }, url);
        }, `jingler://auth/callback?token=${authSessionServer.token}`);
      };

      const completeGitHubConnection = async () => {
        githubServer.connect();
        await app.evaluate(({ app: electronApp }) => {
          electronApp.emit(
            "open-url",
            { preventDefault() {} },
            "jingler://auth/callback?github=connected",
          );
        });
      };

      const githubOperations = () => [...githubServer.operations];

      return {
        app,
        window,
        home,
        reposDir,
        userDataDir,
        repoPath,
        authServer,
        githubServer,
        githubRelay,
        ...(deviceRelay ? { deviceRelay } : {}),
        ...(deviceHome ? { deviceHome } : {}),
        completeDeepLinkSignIn,
        completeGitHubConnection,
        githubOperations,
      };
    };

    await use(launch);

    for (const app of apps) await app.close().catch(() => {});
    // Tear dependent resources down before deleting the directories they may
    // still be writing. In particular, the remote device agent must exit before
    // its temporary home is removed.
    for (const cleanup of cleanups.reverse()) {
      await Promise.resolve(cleanup()).catch(() => {});
    }
  },
});

export { expect } from "@playwright/test";
