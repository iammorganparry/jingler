import { readFileSync } from "node:fs";
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
  await launched.window.getByRole("button", { name: "Verify model" }).click();
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
