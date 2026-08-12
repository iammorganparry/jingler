import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appShell, expect, test, type LaunchedApp } from "./fixtures.js";

const SUBSCRIPTION_ENTITLEMENT = /Test subscription · subscription/;
const SUBSCRIPTION_BILLING = /billing: subscription/;
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
  await launched.window.getByRole("button", { name: "Continue" }).click();
  await expect(
    launched.window.getByRole("heading", { name: "Import agent resources" }),
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

test("connects Claude Max with a pinned setup-token subscription route", async ({
  launchApp,
}) => {
  const token = "sk-ant-oat-e2e-secret";
  const launched = await launchApp({
    withRepo: true,
    piFixture: {
      scenarioId: "onboarding-claude-subscription",
      authRoute: "claude-setup-token",
      seedConnection: false,
    },
  });
  await chooseFixtureRepo(launched);

  const input = launched.window.getByPlaceholder("Claude setup-token");
  await input.fill(token);
  await launched.window.getByRole("button", { name: "Connect Claude" }).click();
  await expect(input).toHaveValue("");
  await finishProviderSetup(launched, "Claude Pro / Max setup-token");

  const metadata = readFileSync(
    join(launched.home, "jingler", "runtime", "provider-connections.json"),
    "utf8",
  );
  expect(metadata).not.toContain(token);
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
  const input = launched.window.getByPlaceholder("Claude setup-token");
  await input.fill("sk-ant-oat-e2e-recovery");
  await launched.window.getByRole("button", { name: "Connect Claude" }).click();
  await finishProviderSetup(launched, "Claude Pro / Max setup-token");
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
            account: { fingerprint: "missing123456", displayLabel: null },
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
  await launched.window.getByRole("button", { name: /Providers/u }).click();
  await expect(
    launched.window.getByText(
      "Reauthentication required. Jingler has not retained usable credentials for this connection.",
    ),
  ).toBeVisible();

  await launched.window
    .getByRole("button", { name: "Reconnect in browser" })
    .click();

  await expect(
    launched.window.getByText(SUBSCRIPTION_BILLING),
  ).toBeVisible();
  await expect(
    launched.window.getByRole("button", { name: "Verify" }),
  ).toBeVisible();
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
  await launched.window.getByRole("button", { name: /Providers/u }).click();
  await expect(
    launched.window.getByText("Add a provider connection"),
  ).toBeVisible();

  await launched.window.getByRole("button", { name: "Open browser" }).click();

  await expect(
    launched.window.getByText("ChatGPT Codex subscription", { exact: true }).last(),
  ).toBeVisible();
  await expect(
    launched.window.getByRole("button", { name: "Verify" }),
  ).toBeVisible();
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

  await launched.window
    .getByPlaceholder("Claude setup-token")
    .fill("sk-ant-oat-e2e-small-window");
  await launched.window.getByRole("button", { name: "Connect Claude" }).click();
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
    launched.window.getByRole("heading", { name: "Import agent resources" }),
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
  await first.window.getByRole("button", { name: "Skip for now" }).click();
  await expect(
    first.window.getByRole("heading", { name: "Import agent resources" }),
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

test("imports every detected agent resource in one action", async ({
  launchApp,
}) => {
  const launched = await launchApp({
    withRepo: true,
    isolateSystemHome: true,
    piFixture: {
      scenarioId: "onboarding-import-all",
      authRoute: "api-key",
      seedConnection: false,
    },
    seed: ({ home }) => {
      const skills = join(home, ".agents", "skills");
      for (const [id, description] of [
        ["deploy", "Deploy safely"],
        ["review", "Review changes"],
      ] as const) {
        const directory = join(skills, id);
        mkdirSync(directory, { recursive: true });
        writeFileSync(
          join(directory, "SKILL.md"),
          `name: ${id}\ndescription: ${description}\n`,
        );
      }
    },
  });
  await chooseFixtureRepo(launched);
  await launched.window.getByRole("button", { name: "Skip for now" }).click();

  await expect(
    launched.window.getByText("deploy", { exact: true }),
  ).toBeVisible();
  await expect(
    launched.window.getByText("review", { exact: true }),
  ).toBeVisible();
  await launched.window.getByRole("button", { name: "Import all" }).click();
  await expect(appShell(launched.window)).toBeVisible();

  await launched.window.getByRole("button", { name: "Account menu" }).click();
  await launched.window.getByRole("menuitem", { name: "Settings" }).click();
  await launched.window
    .getByRole("button", { name: "Agents & skills" })
    .click();
  await expect(
    launched.window.getByText("deploy", { exact: true }),
  ).toBeVisible();
  await expect(
    launched.window.getByText("review", { exact: true }),
  ).toBeVisible();
});
