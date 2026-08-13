import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { Schema } from "effect";
import type { Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import { startBetterAuthTestServer } from "@jingler/server/test-support/better-auth-account";
import { showElectronWindow } from "./electron-window.js";
import { appShell, createWorkspace } from "./fixtures.js";
import { DESKTOP_ROOT, MAIN_ENTRY } from "./global-setup.js";
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

const finishFreshOnboarding = async (window: Page): Promise<void> => {
  const providerStep = window.getByRole("heading", {
    name: "Connect a model provider",
  });
  await expect(providerStep.or(appShell(window))).toBeVisible({
    timeout: 30_000,
  });
  if (!(await providerStep.isVisible())) return;

  await window.bringToFront();
  await expect(appShell(window)).toBeVisible({ timeout: 10 * 60_000 });
};

const prepareRealProviderHome = (home: string): void => {
  const root = join(resolve(home), "jingler");
  const config = join(root, "config.json");
  if (existsSync(config)) return;

  mkdirSync(root, { recursive: true, mode: 0o700 });
  writeFileSync(
    config,
    JSON.stringify(
      {
        reposDir: resolve(DESKTOP_ROOT, "../../.."),
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
};

const selectConnection = async (
  window: Page,
  connectionLabel: string,
): Promise<void> => {
  const connection = window
    .getByRole("button")
    .filter({ hasText: connectionLabel });
  await expect(connection).toBeVisible();
  await connection.click();
};

const modelRow = (window: Page, model: RealProviderTarget) =>
  window
    .getByText(model.modelId, { exact: false })
    .filter({ hasText: model.modelId })
    .locator("..")
    .locator("..");

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
      "Set JINGLER_REAL_CLAUDE_REAUTH=1 to explicitly allow headed Claude setup-token entry.",
    );
    if (!allowClaudeReauthentication) return;
    const token = window.getByPlaceholder("Claude setup-token");
    await window.bringToFront();
    await token.focus();
  }

  await expect(reauthentication).toHaveCount(0, { timeout: 5 * 60_000 });
};

const signInToProduct = async (
  app: ElectronApplication,
  window: Page,
  token: string,
): Promise<void> => {
  const signIn = window.getByRole("heading", { name: "Sign in to Jingler" });
  await Promise.race([
    signIn.waitFor({ state: "visible", timeout: 30_000 }),
    appShell(window).waitFor({ state: "visible", timeout: 30_000 }),
  ]);
  if (!(await signIn.isVisible())) return;
  await app.evaluate(({ app: electronApp }, value) => {
    electronApp.emit(
      "open-url",
      { preventDefault() {} },
      `jingler://auth/callback?token=${encodeURIComponent(value)}`,
    );
  }, token);
};

const certifyModel = async (
  window: Page,
  model: RealProviderTarget,
): Promise<void> => {
  await selectConnection(window, model.connectionLabel);
  await ensureAuthenticated(window, model);
  const row = modelRow(window, model);
  await expect(row).toContainText(model.label);
  const certified = row.getByText(`${model.modelId} · certified`, {
    exact: true,
  });
  if (!(await certified.count())) {
    await row.getByRole("button", { name: "Verify" }).click();
  }
  await expect(certified).toBeVisible({ timeout: 8 * 60_000 });
  const makeDefault = row.getByRole("button", { name: "Make default" });
  if (await makeDefault.isVisible()) await makeDefault.click();
  await expect(row.getByText("Default", { exact: true })).toBeVisible();
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
  const rail = window.getByTestId("review-file-rail");
  if (!(await rail.isVisible())) {
    await window.getByRole("button", { name: "Changed files" }).click();
  }
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

const launchRealProviderApp = async (home: string) => {
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
      JINGLER_E2E: "0",
      JINGLER_E2E_HEADLESS: process.env.JINGLER_E2E_HEADED === "1" ? "0" : "1",
      JINGLER_HOME: resolve(home),
      JINGLER_SCRIPTED_AGENT: "0",
      JINGLER_SECRET_STORE: "",
    };
    const app = await (async () => {
      if (realProviderExecutable._tag === "None") {
        return electron.launch({ args: [MAIN_ENTRY], env });
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
    await finishFreshOnboarding(window);
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
      const first = await launchRealProviderApp(realProviderHome);
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

      const restarted = await launchRealProviderApp(realProviderHome);
      try {
        await runRestartContinuation(restarted.window, expected, changedPath);
      } finally {
        await restarted.app.close();
        await restarted.auth.close();
      }
    });
  }
});
