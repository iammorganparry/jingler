import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { Schema } from "effect";
import type { Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import { appShell, sessionRow } from "./fixtures.js";
import { MAIN_ENTRY } from "./global-setup.js";
import {
  RealProviderRoute,
  realProviderTarget,
  type RealProviderTarget,
} from "./real-provider-targets.js";

const runRealManagedQa = process.env.JINGLER_REAL_MANAGED_QA === "1";
const realAuthToken = process.env.JINGLER_REAL_AUTH_TOKEN;
const realAuthUrl =
  process.env.JINGLER_REAL_AUTH_URL ?? "https://api.jingler.dev";
const realProviderRoute = Schema.decodeUnknownOption(RealProviderRoute)(
  process.env.JINGLER_REAL_PROVIDER_ROUTE,
);
const realClaudeSetupToken = process.env.JINGLER_REAL_CLAUDE_SETUP_TOKEN;
const realCertificationsFile = process.env.JINGLER_REAL_CERTIFICATIONS_FILE;
const repositoryUrl =
  process.env.JINGLER_REAL_MANAGED_REPOSITORY ??
  "https://github.com/iammorganparry/jingler.git";
const DEVICES_SECTION = /^Devices/;
const PROVIDERS_SECTION = /^Providers/u;
const CONTINUATION_ROW = /continuation/i;
const MESSAGE_BOX = /Message/;
const DIRECT_MARKER = "docs/direct-cloud-qa-marker.md";
const HANDOFF_MARKER = "docs/managed-cloud-qa-marker.md";

interface ManagedQaConfig {
  readonly authToken: string;
  readonly certificationsFile: string;
  readonly route: RealProviderRoute;
  readonly setupToken: string | undefined;
}

interface ManagedQaApp {
  readonly app: ElectronApplication;
  readonly root: string;
  readonly window: Page;
}

const managedQaEnabled = (): boolean =>
  runRealManagedQa &&
  realAuthToken !== undefined &&
  realCertificationsFile !== undefined &&
  realProviderRoute._tag === "Some" &&
  (realProviderRoute.value === "codex" || realClaudeSetupToken !== undefined);

const managedQaConfig = (): ManagedQaConfig => {
  if (
    !(realAuthToken && realCertificationsFile) ||
    realProviderRoute._tag === "None" ||
    (realProviderRoute.value === "claude" && !realClaudeSetupToken)
  ) {
    throw new Error("Real managed QA configuration is incomplete");
  }
  return {
    authToken: realAuthToken,
    certificationsFile: realCertificationsFile,
    route: realProviderRoute.value,
    setupToken: realClaudeSetupToken,
  };
};

const configureCurrentModel = async (
  window: Page,
  model: RealProviderTarget,
): Promise<void> => {
  await window.getByRole("button", { name: "Account menu" }).click();
  await window.getByRole("menuitem", { name: "Settings" }).click();
  await window.getByRole("button", { name: PROVIDERS_SECTION }).click();
  await window
    .getByRole("button")
    .filter({ hasText: model.connectionLabel })
    .click();
  const row = window
    .getByText(model.modelId, { exact: false })
    .filter({ hasText: model.modelId })
    .locator("..")
    .locator("..");
  await expect(row).toContainText(`${model.modelId} · certified`);
  const makeDefault = row.getByRole("button", { name: "Make default" });
  if (await makeDefault.isVisible()) await makeDefault.click();
  await expect(row.getByText("Default", { exact: true })).toBeVisible();
  await window.getByRole("button", { name: "Close settings" }).click();
};

const seedManagedQaHome = (
  root: string,
  config: ManagedQaConfig,
): { readonly home: string; readonly userDataDir: string } => {
  const home = join(root, "home");
  const jinglerHome = join(home, "jingler");
  const reposDir = join(root, "repos");
  const repoPath = join(reposDir, "jingler");
  mkdirSync(jinglerHome, { recursive: true });
  mkdirSync(reposDir, { recursive: true });
  execFileSync("git", ["clone", "--depth=1", repositoryUrl, repoPath], {
    stdio: "inherit",
  });
  writeFileSync(join(jinglerHome, "auth.enc"), config.authToken, {
    mode: 0o600,
  });
  writeFileSync(
    join(jinglerHome, "config.json"),
    JSON.stringify({
      reposDir,
      createdAt: new Date().toISOString(),
      lastRepoPath: repoPath,
    }),
  );
  writeFileSync(
    join(jinglerHome, "projects.json"),
    JSON.stringify([
      {
        id: "p_real_managed_qa",
        name: basename(repoPath),
        path: repoPath,
        availability: "available",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]),
  );
  writeFileSync(join(jinglerHome, "sessions.json"), "[]\n");
  mkdirSync(join(jinglerHome, "runtime"), { recursive: true });
  copyFileSync(
    config.certificationsFile,
    join(jinglerHome, "runtime", "certifications.json"),
  );
  return { home, userDataDir: join(root, "chromium") };
};

const launchManagedQaApp = async (
  config: ManagedQaConfig,
): Promise<ManagedQaApp> => {
  const root = mkdtempSync(join(tmpdir(), "jingler-real-managed-"));
  try {
    const { home, userDataDir } = seedManagedQaHome(root, config);
    const app = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
      env: {
        ...process.env,
        ELECTRON_RENDERER_URL: "",
        JINGLER_AUTH_URL: realAuthUrl,
        JINGLER_E2E: "0",
        JINGLER_E2E_HEADLESS:
          process.env.JINGLER_E2E_HEADED === "1" ? "0" : "1",
        JINGLER_HOME: home,
        JINGLER_SECRET_STORE: "memory",
        JINGLER_SCRIPTED_AGENT: "0",
      },
    });
    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    return { app, root, window };
  } catch (cause) {
    rmSync(root, { recursive: true, force: true });
    throw cause;
  }
};

const authenticateProvider = async (
  window: Page,
  config: ManagedQaConfig,
): Promise<void> => {
  await expect(
    window.getByRole("heading", { name: "Connect a model provider" }),
  ).toBeVisible({ timeout: 30_000 });
  if (config.route === "claude") {
    if (!config.setupToken) throw new Error("Claude setup-token is required");
    const token = window.getByPlaceholder("Claude setup-token");
    await token.fill(config.setupToken);
    await window.getByRole("button", { name: "Connect Claude" }).click();
    await expect(token).toHaveValue("");
    await expect(
      window.getByText("Claude Pro / Max setup-token", { exact: true }).last(),
    ).toBeVisible({ timeout: 90_000 });
  } else {
    await window.getByRole("button", { name: "Open browser" }).click();
    await expect(
      window.getByText("ChatGPT Codex subscription", { exact: true }).last(),
    ).toBeVisible({ timeout: 5 * 60_000 });
  }
  await window.getByRole("button", { name: "Continue" }).click();
  await expect(
    window.getByRole("heading", { name: "Import agent resources" }),
  ).toBeVisible({ timeout: 90_000 });
  await window.getByRole("button", { name: "Skip for now" }).click();
  await expect(appShell(window)).toBeVisible({ timeout: 30_000 });
};

const assertCloudAvailable = async (window: Page): Promise<void> => {
  await window.getByRole("button", { name: "Account menu" }).click();
  await window.getByRole("menuitem", { name: "Settings" }).click();
  await window.getByRole("button", { name: DEVICES_SECTION }).click();
  await expect(window.getByText("Cloud", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    window.getByRole("button", { name: "Add cloud environment" }),
  ).toHaveCount(0);
  await window.getByRole("button", { name: "Close settings" }).click();
};

const openNewSession = async (
  window: Page,
  model: RealProviderTarget,
  environment: "Cloud" | "Local",
): Promise<void> => {
  await window.getByTestId("new-session").click();
  await expect(
    window.getByRole("heading", { name: "New session" }),
  ).toBeVisible();
  await expect(
    window.getByRole("button", { name: `Model: ${model.label}` }),
  ).toBeVisible();
  await window.getByRole("button", { name: "Execution environment" }).click();
  await window.getByRole("option", { name: environment }).click();
};

const waitForTurn = async (window: Page): Promise<void> => {
  const stop = window.getByRole("button", { name: "Stop", exact: true });
  await expect(stop).toBeVisible({ timeout: 90_000 });
  await expect(stop).toHaveCount(0, { timeout: 5 * 60_000 });
};

const assertChanges = async (
  window: Page,
  path: string,
  content: string,
): Promise<void> => {
  await window.getByRole("button", { name: "Changes" }).first().click();
  const changes = window.getByRole("region", { name: "Code review changes" });
  await expect(changes).toContainText(path, { timeout: 90_000 });
  await expect(changes).toContainText(content);
  await window.getByTestId("active-chat-tab").click();
};

const waitForCloudStartup = async (window: Page): Promise<void> => {
  await expect(
    window.getByTestId("environment-startup-progress"),
  ).toBeVisible();
  await expect(window.getByTestId("pending-environment-session")).toBeVisible();
  const startupAlert = window.getByRole("alert");
  await Promise.race([
    expect(window.getByTestId("environment-startup-progress")).toHaveCount(0, {
      timeout: 5 * 60_000,
    }),
    startupAlert
      .waitFor({ state: "visible", timeout: 5 * 60_000 })
      .then(async () => {
        throw new Error(
          `Cloud startup failed: ${await startupAlert.textContent()}`,
        );
      }),
  ]);
};

const runDirectCloudTurn = async (
  window: Page,
  model: RealProviderTarget,
): Promise<void> => {
  await openNewSession(window, model, "Cloud");
  await window.getByRole("button", { name: "Create workspace" }).click();
  await waitForCloudStartup(window);
  await expect(sessionRow(window, "Untitled session")).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    window.getByRole("button", { name: "Execution environment" }),
  ).toContainText("Cloud");
  const prompt = window.getByRole("textbox", { name: MESSAGE_BOX });
  await prompt.fill(
    `Create ${DIRECT_MARKER} containing exactly \`direct cloud QA passed\`. Do not commit or push.`,
  );
  await prompt.press("Enter");
  await waitForTurn(window);
  await assertChanges(window, DIRECT_MARKER, "direct cloud QA passed");
};

const startLocalHandoff = async (
  window: Page,
  model: RealProviderTarget,
): Promise<void> => {
  await openNewSession(window, model, "Local");
  const prompt = window.getByRole("textbox", { name: MESSAGE_BOX });
  await prompt.fill(
    `Create ${HANDOFF_MARKER} containing exactly \`managed cloud QA passed\`. Do not commit or push.`,
  );
  await prompt.press("Enter");
  await expect(sessionRow(window, "Untitled session")).toBeVisible({
    timeout: 90_000,
  });
  await waitForTurn(window);
  // Prove the source is dirty before handoff, so a later missing-file failure
  // cannot be confused with a local model that never wrote the file.
  await assertChanges(window, HANDOFF_MARKER, "managed cloud QA passed");
  await prompt.fill("Run `sleep 45` now so I can test a live handoff.");
  await prompt.press("Enter");
  await expect(
    window.getByRole("button", { name: "Stop", exact: true }),
  ).toBeVisible({ timeout: 90_000 });
};

const finishCloudHandoff = async (window: Page): Promise<void> => {
  await window.getByRole("button", { name: "Execution environment" }).click();
  await window.getByRole("option", { name: "Cloud" }).click();
  await expect(window.getByRole("alert")).toContainText("Stop the active turn");
  await window.getByRole("button", { name: "Stop and continue there" }).click();
  const cloudRow = window
    .locator("[data-testid^='session-row-']")
    .filter({ hasText: CONTINUATION_ROW });
  await expect(cloudRow).toBeVisible({ timeout: 3 * 60_000 });
  await cloudRow.click();
  await expect(
    window.getByRole("button", { name: "Execution environment" }),
  ).toContainText("Cloud");
  await assertChanges(window, HANDOFF_MARKER, "managed cloud QA passed");
  const prompt = window.getByRole("textbox", { name: MESSAGE_BOX });
  await prompt.fill(
    `Append a second line containing exactly \`cloud continuation passed\` to ${HANDOFF_MARKER}. Do not commit or push.`,
  );
  await prompt.press("Enter");
  await waitForTurn(window);
};

const closeManagedQaApp = async ({
  app,
  root,
}: ManagedQaApp): Promise<void> => {
  await app.close().catch(() => undefined);
  rmSync(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
};

test.describe("real managed environment canary", () => {
  test.skip(
    !managedQaEnabled(),
    "Set the real managed QA flag, Jingler auth token, reviewed certifications file, and an explicit Claude or Codex provider route.",
  );

  test("runs directly in Cloud, then stops local work and continues it there", async () => {
    test.setTimeout(12 * 60_000);
    const config = managedQaConfig();
    const model = realProviderTarget(config.route);
    const qa = await launchManagedQaApp(config);
    try {
      await authenticateProvider(qa.window, config);
      await configureCurrentModel(qa.window, model);
      await assertCloudAvailable(qa.window);
      await runDirectCloudTurn(qa.window, model);
      await startLocalHandoff(qa.window, model);
      await finishCloudHandoff(qa.window);
      await qa.window.screenshot({
        path: resolve(qa.root, "managed-cloud-handoff.png"),
      });
    } finally {
      await closeManagedQaApp(qa);
    }
  });
});
