import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import { startFakeAuthServer } from "./fake-auth.js";
import { appShell } from "./fixtures.js";
import { MAIN_ENTRY } from "./global-setup.js";
import {
  REAL_PROVIDER_TARGETS,
  type RealProviderTarget,
} from "./real-provider-targets.js";

const runRealProviderQa = process.env.JINGLER_REAL_PROVIDER_QA === "1";
const realProviderHome = process.env.JINGLER_REAL_PROVIDER_HOME;
const realClaudeSetupToken = process.env.JINGLER_REAL_CLAUDE_SETUP_TOKEN;
const PROVIDERS_SECTION = /^Providers/u;

const openProviders = async (window: Page): Promise<void> => {
  await expect(appShell(window)).toBeVisible({ timeout: 30_000 });
  await window.getByRole("button", { name: "Account menu" }).click();
  await window.getByRole("menuitem", { name: "Settings" }).click();
  await window.getByRole("button", { name: PROVIDERS_SECTION }).click();
  await expect(
    window.getByText("Provider connections", { exact: true }),
  ).toBeVisible();
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
    await window.getByRole("button", { name: "Reconnect in browser" }).click();
  } else {
    test.skip(
      !realClaudeSetupToken,
      "Set JINGLER_REAL_CLAUDE_SETUP_TOKEN to explicitly reconnect Claude through production safeStorage.",
    );
    if (!realClaudeSetupToken) return;
    const token = window.getByPlaceholder("Claude setup-token");
    await token.fill(realClaudeSetupToken);
    await window.getByRole("button", { name: "Reconnect Claude" }).click();
    await expect(token).toHaveValue("");
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
): Promise<void> => {
  await window.getByRole("button", { name: "Close settings" }).click();
  await window.getByTestId("new-session").click();
  await expect(
    window.getByRole("heading", { name: "New session" }),
  ).toBeVisible();
  await expect(
    window.getByRole("button", { name: `Model: ${model.label}` }),
  ).toBeVisible();
  await window.getByRole("button", { name: "Create workspace" }).click();
  const composer = window.getByPlaceholder("Message the agent…");
  await expect(composer).toBeVisible({ timeout: 30_000 });
  const expected = `${model.label} real pi turn passed.`;
  await composer.fill(
    `Reply with exactly this sentence and nothing else: ${expected}`,
  );
  await composer.press("Enter");
  await expect(window.getByText(expected, { exact: true }).last()).toBeVisible({
    timeout: 3 * 60_000,
  });
};

const launchRealProviderApp = async (home: string) => {
  // Product sign-in is orthogonal to provider billing. Keep the local auth
  // fixture, but leave the provider document on production safeStorage.
  const auth = await startFakeAuthServer();
  try {
    const app = await electron.launch({
      args: [MAIN_ENTRY],
      env: {
        ...process.env,
        ELECTRON_RENDERER_URL: "",
        JINGLER_AUTH_URL: auth.url,
        JINGLER_E2E: "0",
        JINGLER_E2E_HEADLESS:
          process.env.JINGLER_E2E_HEADED === "1" ? "0" : "1",
        JINGLER_HOME: resolve(home),
        JINGLER_SCRIPTED_AGENT: "0",
        JINGLER_SECRET_STORE: "",
      },
    });
    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    await signInToProduct(app, window, auth.token);
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
      const { app, auth, window } =
        await launchRealProviderApp(realProviderHome);
      try {
        await certifyModel(window, model);
        await runConversation(window, model);
      } finally {
        await app.close();
        await auth.close();
      }
    });
  }
});
