import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { WorkspaceConfig } from "@jingler/core";
import { Schema } from "effect";
import type { Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import { showElectronWindow } from "./electron-window.js";
import { appShell, sessionRow } from "./fixtures.js";
import { MAIN_ENTRY } from "./global-setup.js";
import {
  RealProviderRoute,
  realProviderTarget,
  type RealProviderTarget,
} from "./real-provider-targets.js";

const runRealManagedQa = process.env.JINGLER_REAL_MANAGED_QA === "1";
const realAuthToken = process.env.JINGLER_REAL_AUTH_TOKEN;
const realAuthDocument = process.env.JINGLER_REAL_AUTH_DOCUMENT;
const realAuthUrl =
  process.env.JINGLER_REAL_AUTH_URL ?? "https://api.jingler.dev";
const realProviderRoute = Schema.decodeUnknownOption(RealProviderRoute)(
  process.env.JINGLER_REAL_PROVIDER_ROUTE,
);
const allowClaudeReauthentication =
  process.env.JINGLER_REAL_CLAUDE_REAUTH === "1";
const realCertificationsFile = process.env.JINGLER_REAL_CERTIFICATIONS_FILE;
const realProviderHome = process.env.JINGLER_REAL_PROVIDER_HOME;
const realManagedExecutable = Schema.decodeUnknownOption(
  Schema.String.pipe(Schema.minLength(1)),
)(process.env.JINGLER_REAL_MANAGED_EXECUTABLE);
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
  readonly auth:
    | { readonly kind: "encrypted-document"; readonly path: string }
    | { readonly kind: "token"; readonly value: string };
  readonly certificationsFile: string;
  readonly providerHome: string | undefined;
  readonly route: RealProviderRoute;
  readonly allowClaudeReauthentication: boolean;
}

interface ManagedQaApp {
  readonly app: ElectronApplication;
  readonly root: string;
  readonly window: Page;
}

const managedQaEnabled = (): boolean =>
  runRealManagedQa &&
  (realAuthToken !== undefined || realAuthDocument !== undefined) &&
  realCertificationsFile !== undefined &&
  realProviderRoute._tag === "Some" &&
  (realProviderHome !== undefined ||
    realProviderRoute.value === "codex" ||
    allowClaudeReauthentication);

const managedQaConfig = (): ManagedQaConfig => {
  if (
    !((realAuthToken || realAuthDocument) && realCertificationsFile) ||
    realProviderRoute._tag === "None" ||
    (!realProviderHome &&
      realProviderRoute.value === "claude" &&
      !allowClaudeReauthentication)
  ) {
    throw new Error("Real managed QA configuration is incomplete");
  }
  const auth: ManagedQaConfig["auth"] = realAuthDocument
    ? { kind: "encrypted-document", path: resolve(realAuthDocument) }
    : realAuthToken
      ? { kind: "token", value: realAuthToken }
      : (() => {
          throw new Error("Real managed QA authentication is missing");
        })();
  return {
    auth,
    certificationsFile: realCertificationsFile,
    providerHome: realProviderHome,
    route: realProviderRoute.value,
    allowClaudeReauthentication,
  };
};

const copyRequired = (source: string, destination: string): void => {
  if (!existsSync(source)) {
    throw new Error(`Required real QA document not found: ${source}`);
  }
  copyFileSync(source, destination);
};

const providerState = (
  providerHome: string,
  reposDir: string,
  repoPath: string,
): WorkspaceConfig => {
  const sourceRoot = join(resolve(providerHome), "jingler");
  const sourceConfig = Schema.decodeUnknownSync(
    Schema.parseJson(WorkspaceConfig),
  )(readFileSync(join(sourceRoot, "config.json"), "utf8"));
  return {
    ...sourceConfig,
    reposDir,
    lastRepoPath: repoPath,
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
  const modelChip = window.locator(`button[title="${model.modelId} · certified"]`);
  await expect(modelChip).toBeVisible();
  if ((await modelChip.getAttribute("aria-pressed")) !== "true") {
    await modelChip.click();
  }
  await expect(modelChip).toHaveAttribute("aria-pressed", "true");
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
  if (config.auth.kind === "encrypted-document") {
    copyRequired(config.auth.path, join(jinglerHome, "auth.enc"));
  }
  const workspaceConfig = config.providerHome
    ? providerState(config.providerHome, reposDir, repoPath)
    : {
        reposDir,
        createdAt: new Date().toISOString(),
        lastRepoPath: repoPath,
      };
  writeFileSync(
    join(jinglerHome, "config.json"),
    JSON.stringify(workspaceConfig),
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
  if (config.providerHome) {
    const providerRoot = join(resolve(config.providerHome), "jingler");
    copyRequired(
      join(providerRoot, "auth.enc.devices"),
      join(jinglerHome, "auth.enc.devices"),
    );
    copyRequired(
      join(providerRoot, "runtime", "provider-connections.json"),
      join(jinglerHome, "runtime", "provider-connections.json"),
    );
  }
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
    const env = {
      ...process.env,
      ELECTRON_RENDERER_URL: "",
      JINGLER_AUTH_URL: realAuthUrl,
      JINGLER_DISABLE_AUTO_UPDATE: "1",
      JINGLER_E2E: "0",
      JINGLER_E2E_HEADLESS: process.env.JINGLER_E2E_HEADED === "1" ? "0" : "1",
      JINGLER_HOME: home,
      JINGLER_SECRET_STORE:
        config.auth.kind === "token" && !config.providerHome ? "memory" : "",
      JINGLER_SCRIPTED_AGENT: "0",
    };
    const app = await (async () => {
      if (realManagedExecutable._tag === "None") {
        return electron.launch({
          args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
          env,
        });
      }
      const executablePath = resolve(realManagedExecutable.value);
      if (!existsSync(executablePath)) {
        throw new Error(
          `Packaged Jingler executable not found: ${executablePath}`,
        );
      }
      return electron.launch({
        executablePath,
        args: [`--user-data-dir=${userDataDir}`],
        env,
      });
    })();
    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    if (config.auth.kind === "token") {
      await app.evaluate(({ app: electronApp }, token) => {
        electronApp.emit(
          "open-url",
          { preventDefault() {} },
          `jingler://auth/callback?token=${encodeURIComponent(token)}`,
        );
      }, config.auth.value);
    }
    if (process.env.JINGLER_E2E_HEADED === "1") {
      await showElectronWindow(app);
    }
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
  if (config.providerHome) {
    const signIn = window.getByRole("heading", { name: "Sign in to Jingler" });
    await expect(appShell(window).or(signIn)).toBeVisible({ timeout: 30_000 });
    if (await signIn.isVisible()) {
      if (process.env.JINGLER_E2E_HEADED !== "1") {
        throw new Error(
          "Cloud QA product authentication is missing or expired. Provide a current JINGLER_REAL_AUTH_TOKEN or encrypted auth document.",
        );
      }
      await expect(appShell(window)).toBeVisible({ timeout: 5 * 60_000 });
    }
    return;
  }
  await expect(
    window.getByRole("heading", { name: "Connect a model provider" }),
  ).toBeVisible({ timeout: 90_000 });
  if (config.route === "claude") {
    if (!config.allowClaudeReauthentication) {
      throw new Error("Claude reauthentication was not explicitly enabled");
    }
    await window.getByRole("button", { name: "Use Claude CLI" }).click();
    await expect(
      window.getByText("Claude CLI subscription", { exact: true }).last(),
    ).toBeVisible({ timeout: 5 * 60_000 });
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
  if (!(await prompt.isVisible())) {
    throw new Error(
      `Cloud session opened without a composer. Visible UI:\n${await window.locator("body").innerText()}`,
    );
  }
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

const deleteQaSessions = async (window: Page): Promise<void> => {
  const rows = window.locator("[data-testid^='session-row-']");
  while ((await rows.count()) > 0) {
    const row = rows.first();
    const testId = await row.getAttribute("data-testid");
    if (testId === null) throw new Error("QA session row has no test id");
    await row.click({ button: "right" });
    await window.getByRole("menuitem", { name: "Delete" }).click();
    await window
      .getByRole("dialog")
      .getByRole("button", { name: "Delete" })
      .click();
    await expect(window.getByTestId(testId)).toHaveCount(0, {
      timeout: 90_000,
    });
  }
};

const closeManagedQaApp = async (
  { app, root, window }: ManagedQaApp,
  requireCleanup: boolean,
): Promise<void> => {
  let cleanupError: unknown;
  try {
    if (await appShell(window).isVisible()) await deleteQaSessions(window);
  } catch (cause) {
    cleanupError = cause;
  } finally {
    await app.close().catch(() => undefined);
    rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
  if (requireCleanup && cleanupError !== undefined) throw cleanupError;
};

test.describe("real managed environment canary", () => {
  test.skip(
    !managedQaEnabled(),
    "Set the real managed QA flag, a token or encrypted auth document, reviewed certifications, and an explicit provider route.",
  );

  test("runs directly in Cloud, then stops local work and continues it there", async () => {
    test.setTimeout(12 * 60_000);
    const config = managedQaConfig();
    const model = realProviderTarget(config.route);
    const qa = await launchManagedQaApp(config);
    let completed = false;
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
      completed = true;
    } finally {
      await closeManagedQaApp(qa, completed);
    }
  });
});
