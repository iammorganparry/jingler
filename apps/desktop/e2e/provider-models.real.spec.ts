import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { Schema } from "effect";
import type { Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import { startBetterAuthTestServer } from "@jingler/server/test-support/better-auth-account";
import { WorkspaceConfig } from "@jingler/core";
import { showElectronWindow } from "./electron-window.js";
import { appShell, createWorkspace } from "./fixtures.js";
import { MAIN_ENTRY } from "./global-setup.js";
import {
  REAL_PROVIDER_TARGETS,
  type RealProviderTarget,
} from "./real-provider-targets.js";

const runRealProviderQa = process.env.JINGLER_REAL_PROVIDER_QA === "1";
const realProviderHome = process.env.JINGLER_REAL_PROVIDER_HOME;
const allowClaudeReauthentication =
  process.env.JINGLER_REAL_CLAUDE_REAUTH === "1";
const allowCodexReauthentication =
  process.env.JINGLER_REAL_CODEX_REAUTH === "1";
const realProviderExecutable = Schema.decodeUnknownOption(
  Schema.String.pipe(Schema.minLength(1)),
)(process.env.JINGLER_REAL_PROVIDER_EXECUTABLE);
const PROVIDERS_SECTION = /^Providers/u;
const ASK_BEFORE_ACTIONS = /^Ask Before Actions\b/u;
const ALLOW_ONCE = /Allow once/u;

const openProviders = async (window: Page): Promise<void> => {
  await expect(appShell(window)).toBeVisible({ timeout: 30_000 });
  await window.getByRole("button", { name: "Account menu" }).click();
  await window.getByRole("menuitem", { name: "Settings" }).click();
  await window.getByRole("button", { name: PROVIDERS_SECTION }).click();
  await expect(
    window.getByText("Provider connections", { exact: true }),
  ).toBeVisible();
};

const startProviderAuthentication = async (
  window: Page,
  model: RealProviderTarget,
): Promise<void> => {
  if (model.route === "codex") {
    test.skip(
      !allowCodexReauthentication,
      "Set JINGLER_REAL_CODEX_REAUTH=1 to explicitly start interactive Codex browser login.",
    );
    if (!allowCodexReauthentication) return;
    await window.getByRole("button", { name: "Open browser" }).click();
  } else {
    test.skip(
      !allowClaudeReauthentication,
      "Set JINGLER_REAL_CLAUDE_REAUTH=1 to explicitly use the local Claude CLI login.",
    );
    if (!allowClaudeReauthentication) return;
    await window.getByRole("button", { name: "Use Claude CLI" }).click();
  }

  await expect
    .poll(
      () => window.getByText(model.connectionLabel, { exact: true }).count(),
      { timeout: 5 * 60_000 },
    )
    .toBeGreaterThan(0);
};

const finishFreshOnboarding = async (
  window: Page,
  model: RealProviderTarget,
): Promise<void> => {
  const providerStep = window.getByRole("heading", {
    name: "Connect a model provider",
  });
  const resourcesStep = window.getByRole("heading", {
    name: "Import agent resources",
  });
  const accountMenu = window.getByRole("button", { name: "Account menu" });
  await expect(providerStep.or(resourcesStep).or(accountMenu)).toBeVisible({
    timeout: 30_000,
  });
  if (await providerStep.isVisible()) {
    await window.bringToFront();
    await startProviderAuthentication(window, model);
    const continueButton = window.getByRole("button", { name: "Continue" });
    await expect(
      continueButton.or(resourcesStep).or(accountMenu),
    ).toBeVisible({ timeout: 30_000 });
    if (await continueButton.isVisible()) await continueButton.click();
    await expect(resourcesStep.or(accountMenu)).toBeVisible({
      timeout: 30_000,
    });
  }
  if (await resourcesStep.isVisible()) {
    await window.getByRole("button", { name: "Skip for now" }).click();
  }
  await expect(accountMenu).toBeVisible({ timeout: 10 * 60_000 });
};

const prepareCanaryRepo = (home: string): string => {
  const repo = join(resolve(home), "repos", "pi-real-canary");
  mkdirSync(repo, { recursive: true, mode: 0o700 });
  if (existsSync(join(repo, ".git"))) return repo;

  execFileSync("git", ["init", "--quiet", repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Jingler QA"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "qa@jingler.test"]);
  writeFileSync(join(repo, "README.md"), "# Jingler real pi canary\n");
  execFileSync("git", ["-C", repo, "add", "README.md"]);
  execFileSync("git", [
    "-C",
    repo,
    "commit",
    "--quiet",
    "-m",
    "Initial QA fixture",
  ]);
  return repo;
};

const prepareRealProviderHome = (home: string): void => {
  const root = join(resolve(home), "jingler");
  const reposDir = join(resolve(home), "repos");
  const repo = prepareCanaryRepo(home);
  const configFile = join(root, "config.json");
  const now = new Date().toISOString();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const current = existsSync(configFile)
    ? Schema.decodeUnknownSync(Schema.parseJson(WorkspaceConfig))(
        readFileSync(configFile, "utf8"),
      )
    : { reposDir, createdAt: now };
  writeFileSync(
    configFile,
    JSON.stringify({ ...current, reposDir, lastRepoPath: repo }, null, 2),
    { mode: 0o600 },
  );
  writeFileSync(
    join(root, "projects.json"),
    JSON.stringify(
      [
        {
          id: "p_real_pi_canary",
          name: "pi-real-canary",
          path: repo,
          availability: "available",
          createdAt: now,
          updatedAt: now,
        },
      ],
      null,
      2,
    ),
    { mode: 0o600 },
  );
};

const selectConnection = async (
  window: Page,
  model: RealProviderTarget,
): Promise<void> => {
  const connection = window
    .getByRole("button")
    .filter({ hasText: model.connectionLabel });
  if (!(await connection.count())) {
    await window.getByRole("button", { name: "Add runtime" }).click();
    await startProviderAuthentication(window, model);
  }
  await expect(connection).toBeVisible();
  await connection.click();
};

const modelRow = (window: Page, model: RealProviderTarget) =>
  window.locator(`button[title^="${model.modelId} ·"]`);

const ensureAuthenticated = async (
  window: Page,
  model: RealProviderTarget,
): Promise<void> => {
  const reauthentication = window.getByText(
    "Reauthentication required. Jingler has not retained usable credentials for this connection.",
    { exact: true },
  );
  if (!(await reauthentication.isVisible())) return;

  if (model.providerId === "openai-codex") {
    test.skip(
      !allowCodexReauthentication,
      "Set JINGLER_REAL_CODEX_REAUTH=1 to explicitly start interactive Codex browser login.",
    );
    if (!allowCodexReauthentication) return;
    await window.getByRole("button", { name: "Reconnect in browser" }).click();
  } else {
    test.skip(
      !allowClaudeReauthentication,
      "Set JINGLER_REAL_CLAUDE_REAUTH=1 to explicitly use the local Claude CLI login.",
    );
    if (!allowClaudeReauthentication) return;
    await window.getByRole("button", { name: "Reconnect Claude CLI" }).click();
  }

  await expect(reauthentication).toHaveCount(0, { timeout: 5 * 60_000 });
};

const signInToProduct = async (
  app: ElectronApplication,
  window: Page,
  token: string,
): Promise<void> => {
  // Sign-in is optional: the account menu always renders, and reads
  // "Not signed in" until a session exists.
  const accountMenu = window.getByRole("button", { name: "Account menu" });
  const signIn = accountMenu.getByText("Not signed in");
  await expect(accountMenu).toBeVisible({ timeout: 30_000 });
  if (!(await signIn.isVisible())) return;
  await app.evaluate(({ app: electronApp }, value) => {
    electronApp.emit(
      "open-url",
      { preventDefault() {} },
      `jingler://auth/callback?token=${encodeURIComponent(value)}`,
    );
  }, token);
  await expect(signIn).not.toBeVisible({ timeout: 30_000 });
};

const certifyModel = async (
  window: Page,
  model: RealProviderTarget,
): Promise<void> => {
  await selectConnection(window, model);
  await ensureAuthenticated(window, model);
  const row = modelRow(window, model);
  await expect(row).toContainText(model.label);
  if ((await row.getAttribute("title")) !== `${model.modelId} · certified`) {
    await row.click();
  }
  await expect(row).toHaveAttribute("title", `${model.modelId} · certified`, {
    timeout: 8 * 60_000,
  });
  if ((await row.getAttribute("aria-pressed")) !== "true") await row.click();
  await expect(row).toHaveAttribute("aria-pressed", "true");
};

const runConversation = async (
  window: Page,
  model: RealProviderTarget,
): Promise<string> => {
  await window.getByRole("button", { name: "Close settings" }).click();
  await createWorkspace(window, "Real pi provider canary");
  await expect(
    window.getByRole("button", { name: `Model: ${model.label}` }),
  ).toBeVisible();
  const composer = window.getByPlaceholder("Message the agent…");
  await expect(composer).toBeVisible({ timeout: 30_000 });
  const expected = `${model.label} real pi history ${randomUUID()}.`;
  await composer.fill(
    `Reply with exactly this sentence and nothing else: ${expected}`,
  );
  await composer.press("Enter");
  await expect(window.getByText(expected, { exact: true }).last()).toBeVisible({
    timeout: 3 * 60_000,
  });
  return expected;
};

const runWorkspaceMutation = async (
  window: Page,
  model: RealProviderTarget,
): Promise<string> => {
  const path = `docs/real-pi-${model.route}-canary.md`;
  const content = `${model.label} wrote this through Jingler's pi runtime.\n`;
  const composer = window.getByPlaceholder("Message the agent…");

  await window
    .getByRole("button", { name: "Accept Edits", exact: true })
    .click();
  await window.getByRole("option", { name: ASK_BEFORE_ACTIONS }).click();
  await composer.fill(
    `Call workspace_write exactly once with path ${path} and this exact content: ${JSON.stringify(content)}. Do not use command_execute.`,
  );
  await composer.press("Enter");

  await expect(window.getByRole("button", { name: ALLOW_ONCE })).toBeVisible({
    timeout: 3 * 60_000,
  });
  await window.getByRole("button", { name: ALLOW_ONCE }).click();

  const change = window.locator(
    `[data-file-change="A"][data-file-path="${path}"]`,
  );
  await expect(change).toBeVisible({ timeout: 3 * 60_000 });
  await expect(change).toContainText(path);
  await expect(change).toContainText("Created");

  await window.getByRole("button", { name: "Changes" }).first().click();
  const rail = window.getByTestId("changed-files-explorer");
  await expect(rail.locator(`[data-item-path="${path}"]`)).toHaveAttribute(
    "data-item-git-status",
    "added",
    { timeout: 30_000 },
  );
  return path;
};

const runRestartContinuation = async (
  window: Page,
  expected: string,
  changedPath: string,
): Promise<void> => {
  await window.getByRole("button", { name: "Close settings" }).click();
  await expect(
    window.locator(`[data-file-change="A"][data-file-path="${changedPath}"]`),
  ).toBeVisible({ timeout: 30_000 });
  const composer = window.getByPlaceholder("Message the agent…");
  await expect(composer).toBeVisible({ timeout: 30_000 });
  await composer.fill(
    "Repeat the exact canary sentence from my first message. Reply with that sentence and nothing else.",
  );
  await composer.press("Enter");
  await expect(window.getByText(expected, { exact: true }).last()).toBeVisible({
    timeout: 3 * 60_000,
  });
};

const launchRealProviderApp = async (
  home: string,
  model: RealProviderTarget,
) => {
  // Product sign-in is orthogonal to provider billing. Use Better Auth's real
  // test-account support, but leave provider credentials on production
  // safeStorage and make first-run provider authentication explicitly manual.
  prepareRealProviderHome(home);
  const auth = await startBetterAuthTestServer();
  try {
    const env = {
      ...process.env,
      ELECTRON_RENDERER_URL: "",
      JINGLER_AUTH_URL: auth.url,
      JINGLER_DISABLE_AUTO_UPDATE: "1",
      JINGLER_E2E: "0",
      JINGLER_E2E_HEADLESS: process.env.JINGLER_E2E_HEADED === "1" ? "0" : "1",
      JINGLER_HOME: resolve(home),
      JINGLER_SCRIPTED_AGENT: "0",
      JINGLER_SECRET_STORE: "",
    };
    const app = await (async () => {
      if (realProviderExecutable._tag === "None") {
        return electron.launch({
          args: [
            MAIN_ENTRY,
            `--user-data-dir=${resolve(home, "chromium-real-provider")}`,
          ],
          env,
        });
      }
      const executablePath = resolve(realProviderExecutable.value);
      if (!existsSync(executablePath)) {
        throw new Error(
          `Packaged Jingler executable not found: ${executablePath}`,
        );
      }
      return electron.launch({
        executablePath,
        args: [`--user-data-dir=${resolve(home, "chromium-real-provider")}`],
        env,
      });
    })();
    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    if (process.env.JINGLER_E2E_HEADED === "1") {
      await showElectronWindow(app);
    }
    await signInToProduct(app, window, auth.token);
    await finishFreshOnboarding(window, model);
    await openProviders(window);
    return { app, auth, window };
  } catch (cause) {
    await auth.close();
    throw cause;
  }
};

test.describe("real current provider models", () => {
  test.skip(
    !(runRealProviderQa && realProviderHome),
    "Set JINGLER_REAL_PROVIDER_QA=1 and JINGLER_REAL_PROVIDER_HOME to a production-authenticated Jingler home.",
  );

  for (const model of REAL_PROVIDER_TARGETS) {
    test(`certifies ${model.label} through production pi`, async () => {
      test.setTimeout(12 * 60_000);
      if (!realProviderHome) throw new Error("Real provider home is required");
      const first = await launchRealProviderApp(realProviderHome, model);
      let expected: string;
      let changedPath: string;
      try {
        await certifyModel(first.window, model);
        expected = await runConversation(first.window, model);
        changedPath = await runWorkspaceMutation(first.window, model);
      } finally {
        await first.app.close();
        await first.auth.close();
      }

      const restarted = await launchRealProviderApp(realProviderHome, model);
      try {
        await runRestartContinuation(restarted.window, expected, changedPath);
      } finally {
        await restarted.app.close();
        await restarted.auth.close();
      }
    });
  }
});
