import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { appShell, expect, test, type LaunchedApp } from "./fixtures.js";

const SUBSCRIPTION_ENTITLEMENT = /Test subscription · subscription/;
const SUBSCRIPTION_BILLING = /billing: subscription/;
const DETERMINISTIC_MODEL = /^Deterministic pi model 1/u;
const PROVIDERS_NAV = /Providers/u;
const STALE_MODEL_TITLE = / · stale$/u;
const GPT_6_1_SOL = /^GPT-6\.1 Sol/u;
const CODEX_BINARY = resolve(
  import.meta.dirname,
  "../../../packages/cli-adapters/src/runtime/codex/fixtures/app-server.mjs",
);
const chooseFixtureRepo = async (launched: LaunchedApp): Promise<void> => {
  await launched.app.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [selected],
    });
  }, launched.reposDir);
  await launched.window
    .getByRole("button", { name: "Choose repos folder" })
    .click();
  await launched.window.getByRole("button", { name: "Continue" }).click();
  await launched.window.getByRole("button", { name: "Skip for now" }).click();
  await expect(
    launched.window.getByRole("heading", { name: "Connect a model provider" }),
  ).toBeVisible();
};

const finishProviderSetup = async (
  launched: LaunchedApp,
  routeLabel: string,
): Promise<void> => {
  await expect(
    launched.window.getByText(routeLabel, { exact: true }).last(),
  ).toBeVisible();
  await expect(
    launched.window.getByText(SUBSCRIPTION_ENTITLEMENT),
  ).toBeVisible();
  await expect(
    launched.window.getByRole("button", { name: "Verify model" }),
  ).toHaveCount(0);
  await expect(launched.window.getByText("Add another account")).toBeVisible();
  await expect(
    launched.window.getByRole("button", { name: "Connect Claude through PI" }),
  ).toBeHidden();
  await expect(
    launched.window.getByRole("button", { name: "Open browser" }),
  ).toBeHidden();
  await launched.window.getByRole("button", { name: "Continue" }).click();
  // #487 removed the standalone resources onboarding step; onboarding now
  // continues straight to the import-sessions step.
  await expect(
    launched.window.getByRole("heading", { name: "Import existing sessions?" }),
  ).toBeVisible();
  await launched.window.getByRole("button", { name: "Skip for now" }).click();
  await expect(appShell(launched.window)).toBeVisible();

  await launched.window.getByRole("button", { name: "Account menu" }).click();
  await launched.window.getByRole("menuitem", { name: "Settings" }).click();
  await expect(
    launched.window.getByText(routeLabel, { exact: true }).first(),
  ).toBeVisible();
  await expect(launched.window.getByText(SUBSCRIPTION_BILLING)).toBeVisible();
};

const PROVIDER_ICON_KIND: Record<string, string> = {
  "Claude CLI subscription": "claude",
  "ChatGPT Codex subscription": "codex",
};

const expectAccountRowLogo = async (
  launched: LaunchedApp,
  routeLabel: string,
): Promise<void> => {
  const kind = PROVIDER_ICON_KIND[routeLabel];
  if (!kind) throw new Error(`no expected provider-icon kind for ${routeLabel}`);
  const row = launched.window
    .getByRole("button", { name: new RegExp(routeLabel) })
    .first();
  await expect(row.locator(`[data-provider-icon="${kind}"]`)).toBeVisible();
  await expect(row.locator("[data-provider-fallback]")).toHaveCount(0);
};

test("connects the local Claude CLI subscription without collecting credentials", async ({
  launchApp,
}) => {
  const launched = await launchApp({
    withRepo: true,
    piFixture: {
      scenarioId: "onboarding-claude-subscription",
      authRoute: "claude-setup-token",
      seedConnection: false,
    },
  });
  await chooseFixtureRepo(launched);

  await launched.window.getByRole("button", { name: "Connect Claude through PI" }).click();
  await expect(launched.window.getByPlaceholder("Claude setup-token")).toHaveCount(0);
  await finishProviderSetup(launched, "Claude CLI subscription");
  await expectAccountRowLogo(launched, "Claude CLI subscription");

  const metadata = readFileSync(
    join(launched.home, "jingler", "runtime", "provider-connections.json"),
    "utf8",
  );
  expect(metadata).not.toContain("sk-ant-oat");
});

test("connects ChatGPT Codex with a pinned OAuth subscription route", async ({
  launchApp,
}) => {
  const launched = await launchApp({
    withRepo: true,
    piFixture: {
      scenarioId: "onboarding-codex-subscription",
      authRoute: "openai-codex-oauth",
      seedConnection: false,
    },
  });
  await chooseFixtureRepo(launched);

  await launched.window.getByRole("button", { name: "Open browser" }).click();
  await finishProviderSetup(launched, "ChatGPT Codex subscription");
});

test("connects ChatGPT Codex with device-code OAuth through the main process", async ({
  launchApp,
}) => {
  const launched = await launchApp({
    withRepo: true,
    piFixture: {
      scenarioId: "onboarding-codex-device-code",
      authRoute: "openai-codex-oauth",
      seedConnection: false,
    },
  });
  await chooseFixtureRepo(launched);

  await launched.window
    .getByRole("button", { name: "Use device code" })
    .click();
  await expect(launched.window.getByText("JING-LER1")).toBeVisible();
  await expect(
    launched.window.getByText("https://login.example.test/device"),
  ).toBeVisible();
  await finishProviderSetup(launched, "ChatGPT Codex subscription");
});

test("recovers a configured workspace that has no selectable provider", async ({
  launchApp,
}) => {
  const launched = await launchApp({
    configured: true,
    withRepo: true,
    piFixture: {
      scenarioId: "configured-provider-recovery",
      authRoute: "claude-setup-token",
      seedConnection: false,
    },
  });

  await expect(
    launched.window.getByRole("heading", { name: "Connect a model provider" }),
  ).toBeVisible();
  await launched.window.getByRole("button", { name: "Connect Claude through PI" }).click();
  await finishProviderSetup(launched, "Claude CLI subscription");
});

test("reconnects a restored subscription whose encrypted credential is missing", async ({
  launchApp,
}) => {
  const connectionId = "codex-missing-credential";
  const launched = await launchApp({
    configured: true,
    withRepo: true,
    config: { providerSetupCompleted: true },
    piFixture: {
      scenarioId: "provider-settings-reauthentication",
      authRoute: "openai-codex-oauth",
      seedConnection: false,
    },
    seed: ({ home }) => {
      const runtime = join(home, "jingler", "runtime");
      mkdirSync(runtime, { recursive: true });
      writeFileSync(
        join(runtime, "provider-connections.json"),
        JSON.stringify([
          {
            id: connectionId,
            providerId: "openai-codex",
            authKind: "openai-codex-oauth",
            account: { fingerprint: "missing-credential", displayLabel: null },
            targetId: "desktop",
            status: "authenticated",
            subscription: {
              entitlement: "active",
              planLabel: "Test subscription",
              expiresAt: "2026-08-22T09:32:34.581Z",
              quotaLabel: null,
              rateLimitLabel: null,
              confirmedBillingRoute: "subscription",
            },
            createdAt: "2026-08-12T09:32:36.863Z",
            updatedAt: "2026-08-12T09:32:36.863Z",
          },
        ]),
      );
    },
  });

  await launched.window.getByRole("button", { name: "Account menu" }).click();
  await launched.window.getByRole("menuitem", { name: "Settings" }).click();
  await launched.window.getByRole("button", { name: PROVIDERS_NAV }).click();
  await expect(
    launched.window.getByText(
      "Reauthentication required. Jingler has not retained usable credentials for this connection.",
    ),
  ).toBeVisible();

  await launched.window.getByRole("button", { name: "Reconnect", exact: true }).click();
  const sheet = launched.window.getByRole("dialog");
  await expect(sheet.getByRole("button", { name: "Use device code" })).toBeVisible();
  await sheet.getByRole("button", { name: "Open browser" }).click();

  await expect(
    launched.window.getByText(SUBSCRIPTION_BILLING),
  ).toBeVisible();
  await expect(
    launched.window.getByRole("button", { name: DETERMINISTIC_MODEL }),
  ).toBeVisible();
});

test("cancels a hung Codex OAuth login from the reconnect sheet", async ({
  launchApp,
}) => {
  const connectionId = "codex-login-hangs";
  const launched = await launchApp({
    configured: true,
    withRepo: true,
    config: { providerSetupCompleted: true },
    piFixture: {
      scenarioId: "provider-settings-reauthentication",
      authRoute: "openai-codex-oauth",
      seedConnection: false,
      codexLoginHangs: true,
    },
    seed: ({ home }) => {
      const runtime = join(home, "jingler", "runtime");
      mkdirSync(runtime, { recursive: true });
      writeFileSync(
        join(runtime, "provider-connections.json"),
        JSON.stringify([
          {
            id: connectionId,
            providerId: "openai-codex",
            authKind: "openai-codex-oauth",
            account: { fingerprint: "missing-credential", displayLabel: null },
            targetId: "desktop",
            status: "authenticated",
            subscription: {
              entitlement: "active",
              planLabel: "Test subscription",
              expiresAt: "2026-08-22T09:32:34.581Z",
              quotaLabel: null,
              rateLimitLabel: null,
              confirmedBillingRoute: "subscription",
            },
            createdAt: "2026-08-12T09:32:36.863Z",
            updatedAt: "2026-08-12T09:32:36.863Z",
          },
        ]),
      );
    },
  });

  await launched.window.getByRole("button", { name: "Account menu" }).click();
  await launched.window.getByRole("menuitem", { name: "Settings" }).click();
  await launched.window.getByRole("button", { name: PROVIDERS_NAV }).click();
  await launched.window.getByRole("button", { name: "Reconnect", exact: true }).click();
  const sheet = launched.window.getByRole("dialog");
  await sheet.getByRole("button", { name: "Open browser" }).click();

  await expect(
    sheet.getByText("Waiting for browser sign-in…"),
  ).toBeVisible();
  await sheet.getByRole("button", { name: "Cancel" }).click();

  await expect(
    sheet.getByRole("button", { name: "Open browser" }),
  ).toBeVisible();
  await expect(
    sheet.getByText("Waiting for browser sign-in…"),
  ).toBeHidden();
});

test("keeps the typed API key and shows an error when verification rejects it", async ({
  launchApp,
}) => {
  const connectionId = "codex-reject-api-key";
  const launched = await launchApp({
    configured: true,
    withRepo: true,
    config: { providerSetupCompleted: true },
    piFixture: {
      scenarioId: "provider-settings-reauthentication",
      authRoute: "openai-codex-oauth",
      seedConnection: false,
      rejectApiKey: "The provider rejected this API key.",
    },
    seed: ({ home }) => {
      const runtime = join(home, "jingler", "runtime");
      mkdirSync(runtime, { recursive: true });
      writeFileSync(
        join(runtime, "provider-connections.json"),
        JSON.stringify([
          {
            id: connectionId,
            providerId: "openai-codex",
            authKind: "openai-codex-oauth",
            account: { fingerprint: "missing-credential", displayLabel: null },
            targetId: "desktop",
            status: "authenticated",
            subscription: {
              entitlement: "active",
              planLabel: "Test subscription",
              expiresAt: "2026-08-22T09:32:34.581Z",
              quotaLabel: null,
              rateLimitLabel: null,
              confirmedBillingRoute: "subscription",
            },
            createdAt: "2026-08-12T09:32:36.863Z",
            updatedAt: "2026-08-12T09:32:36.863Z",
          },
        ]),
      );
    },
  });

  await launched.window.getByRole("button", { name: "Account menu" }).click();
  await launched.window.getByRole("menuitem", { name: "Settings" }).click();
  await launched.window.getByRole("button", { name: PROVIDERS_NAV }).click();
  await launched.window.getByRole("button", { name: "Reconnect", exact: true }).click();
  const sheet = launched.window.getByRole("dialog");
  await sheet.getByRole("tab", { name: "API key" }).click();
  await sheet.getByPlaceholder("Provider API key").fill("sk-bad");
  await sheet.getByRole("button", { name: "Save API key" }).click();

  await expect(
    sheet.getByText("The provider rejected this API key."),
  ).toBeVisible();
  await expect(sheet.getByPlaceholder("Provider API key")).toHaveValue("sk-bad");
});

test("adds a provider from settings after provider onboarding was skipped", async ({
  launchApp,
}) => {
  const launched = await launchApp({
    configured: true,
    withRepo: true,
    config: { providerSetupCompleted: true },
    piFixture: {
      scenarioId: "provider-settings-add-connection",
      authRoute: "openai-codex-oauth",
      seedConnection: false,
    },
  });

  await launched.window.getByRole("button", { name: "Account menu" }).click();
  await launched.window.getByRole("menuitem", { name: "Settings" }).click();
  await launched.window.getByRole("button", { name: PROVIDERS_NAV }).click();
  await expect(
    launched.window.getByText("Add an agent runtime"),
  ).toBeVisible();

  await launched.window.getByRole("button", { name: "Open browser" }).click();

  await expect(
    launched.window.getByText("ChatGPT Codex subscription", { exact: true }).last(),
  ).toBeVisible();
  await expect(
    launched.window.getByRole("button", { name: DETERMINISTIC_MODEL }),
  ).toBeVisible();
});

test("shows installed Codex CLI models on the PI subscription connection", async ({ launchApp }) => {
  const launched = await launchApp({
    configured: true,
    withRepo: true,
    config: { providerSetupCompleted: true },
    piFixture: {
      scenarioId: "pi-codex-cli-models",
      authRoute: "openai-codex-oauth",
    },
    e2eEnv: {
      JINGLER_CODEX_BINARY: CODEX_BINARY,
      CODEX_HOME: "latest-models",
    },
  });

  await launched.window.getByRole("button", { name: "Account menu" }).click();
  await launched.window.getByRole("menuitem", { name: "Settings" }).click();
  await launched.window.getByRole("button", { name: PROVIDERS_NAV }).click();
  await expect(
    launched.window.getByRole("button", { name: GPT_6_1_SOL }),
  ).toBeVisible();
});

test("rejects a duplicate provider connection from settings", async ({ launchApp }) => {
  const launched = await launchApp({
    configured: true,
    withRepo: true,
    config: { providerSetupCompleted: true },
    piFixture: {
      scenarioId: "provider-settings-second-connection",
      authRoute: "openai-codex-oauth",
    },
  });

  await launched.window.getByRole("button", { name: "Account menu" }).click();
  await launched.window.getByRole("menuitem", { name: "Settings" }).click();
  await launched.window.getByRole("button", { name: PROVIDERS_NAV }).click();
  await launched.window.getByRole("button", { name: "Add runtime" }).click();
  await launched.window.getByRole("button", { name: "Open browser" }).click();

  await expect(
    launched.window.getByText("This provider connection already exists on this target", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    launched.window.getByRole("button", {
      name: "Sign out ChatGPT Codex subscription connection",
    }),
  ).toHaveCount(1);
});

test("shows a stale canonical default model as unavailable in provider settings", async ({
  launchApp,
}) => {
  const launched = await launchApp({
    configured: true,
    withRepo: true,
    piFixture: {
      scenarioId: "provider-stale-default",
      authRoute: "claude-setup-token",
      staleCertification: true,
    },
  });

  await launched.window.getByRole("button", { name: "Account menu" }).click();
  await launched.window.getByRole("menuitem", { name: "Settings" }).click();
  await launched.window.getByRole("button", { name: PROVIDERS_NAV }).click();
  const modelChip = launched.window.getByRole("button", {
    name: DETERMINISTIC_MODEL,
  });
  await expect(modelChip).toBeVisible();
  await expect(modelChip).toHaveAttribute("title", STALE_MODEL_TITLE);

  await expect(modelChip).toBeDisabled();
  await expect(modelChip).toHaveAttribute("aria-pressed", "true");
});

test("provider onboarding remains reachable at the minimum window height", async ({
  launchApp,
}) => {
  const launched = await launchApp({
    withRepo: true,
    piFixture: {
      scenarioId: "onboarding-small-window",
      authRoute: "claude-setup-token",
      seedConnection: false,
      modelCount: 30,
    },
  });
  await launched.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(900, 600);
  });
  await chooseFixtureRepo(launched);

  await launched.window.getByRole("button", { name: "Connect Claude through PI" }).click();
  const heading = launched.window.getByRole("heading", {
    name: "Connect a model provider",
  });
  await heading.evaluate((element) =>
    element.scrollIntoView({ block: "start" }),
  );
  const headingBox = await heading.boundingBox();
  expect(headingBox).not.toBeNull();
  expect(headingBox?.y ?? -1).toBeGreaterThanOrEqual(0);

  const continueButton = launched.window.getByRole("button", {
    name: "Continue",
  });
  await continueButton.scrollIntoViewIfNeeded();
  await expect(continueButton).toBeVisible();
  await continueButton.click();
  await expect(
    launched.window.getByRole("heading", { name: "Import existing sessions?" }),
  ).toBeVisible();
});

test("skips provider setup and preserves that choice across restart", async ({
  launchApp,
}) => {
  const first = await launchApp({
    withRepo: true,
    piFixture: {
      scenarioId: "onboarding-provider-skip",
      authRoute: "api-key",
      seedConnection: false,
    },
  });
  await chooseFixtureRepo(first);

  await expect(
    first.window.getByRole("button", { name: "Continue" }),
  ).toBeDisabled();
  await expect(
    first.window.getByText("Connect a provider to continue, or skip for now.", { exact: true }),
  ).toBeVisible();
  await first.window.getByRole("button", { name: "Skip for now" }).click();
  await expect(
    first.window.getByRole("heading", { name: "Import existing sessions?" }),
  ).toBeVisible();
  await first.window.getByRole("button", { name: "Skip for now" }).click();
  await expect(appShell(first.window)).toBeVisible();
  await first.app.close();

  const restarted = await launchApp({
    home: first.home,
    reposDir: first.reposDir,
    userDataDir: first.userDataDir,
    configured: true,
    withRepo: true,
  });
  await expect(appShell(restarted.window)).toBeVisible();
  await expect(
    restarted.window.getByRole("heading", {
      name: "Connect a model provider",
    }),
  ).toHaveCount(0);
});

test("detects native Claude during onboarding without a PI connection", async ({ launchApp }) => {
  const launched = await launchApp({
    withRepo: true,
    piFixture: { scenarioId: "composer-capabilities", authRoute: "openai-codex-oauth", seedConnection: false },
    e2eEnv: { JINGLER_CLAUDE_BINARY: resolve(import.meta.dirname, "../../../packages/cli-adapters/src/runtime/agent/fixtures/claude-tools.mjs") }
  })
  await chooseFixtureRepo(launched)
  await expect(launched.window.getByText("Claude Code · ready", { exact: true })).toBeVisible()
  await launched.window.getByRole("button", { name: "Continue", exact: true }).click()
  await expect(launched.window.getByRole("heading", { name: "Import existing sessions?" })).toBeVisible()
  await launched.window.getByRole("button", { name: "Skip for now" }).click()
  await expect(appShell(launched.window)).toBeVisible()
  await launched.window.reload()
  await expect(appShell(launched.window)).toBeVisible()
})

test("a signed-out subscription offers Reconnect in place and never falls back to an API key", async ({
  launchApp,
}) => {
  const connectionId = "codex-signed-out";
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    config: { providerSetupCompleted: true },
    piFixture: {
      scenarioId: "provider-settings-reauthentication",
      authRoute: "openai-codex-oauth",
      seedConnection: false,
    },
    sessions: [
      {
        id: "s_signed_out",
        repo: "widget",
        branch: "chore/signed-out",
        title: "Signed out run",
        status: "idle",
        diff: { added: 0, removed: 0 },
        prNumber: null,
        costUsd: 0,
        tokens: 0,
        updatedAt: "2026-09-26T00:00:00.000Z",
        chats: [
          {
            id: "c_signed_out",
            title: null,
            createdAt: "2026-09-26T00:00:00.000Z",
            updatedAt: "2026-09-26T00:00:00.000Z",
            connectionId,
            providerId: "openai-codex",
            modelId: "openai-codex/gpt-5.6-sol",
          },
        ],
      },
    ],
    seed: ({ home }) => {
      const runtime = join(home, "jingler", "runtime");
      mkdirSync(runtime, { recursive: true });
      writeFileSync(
        join(runtime, "provider-connections.json"),
        JSON.stringify([
          {
            id: connectionId,
            providerId: "openai-codex",
            authKind: "openai-codex-oauth",
            account: { fingerprint: "signed-out", displayLabel: null },
            targetId: "desktop",
            status: "expired",
            subscription: {
              entitlement: "active",
              planLabel: "Test subscription",
              expiresAt: null,
              quotaLabel: null,
              rateLimitLabel: null,
              confirmedBillingRoute: "subscription",
            },
            createdAt: "2026-08-12T09:32:36.863Z",
            updatedAt: "2026-08-12T09:32:36.863Z",
          },
        ]),
      );
    },
  });

  await window.getByText("Signed out run").first().click();
  const card = window.getByRole("region", { name: "Provider signed out" });
  await expect(card).toContainText("signed out during this run");
  await expect(card).toContainText("never falls back to an API key");
  await card.getByRole("button", { name: "Reconnect", exact: true }).click();
  await window.getByRole("dialog").getByRole("button", { name: "Open browser" }).click();
  await expect(
    window.getByRole("region", { name: "Provider reconnected" }).getByRole("button", { name: "Resume run", exact: true }),
  ).toBeVisible();
});
