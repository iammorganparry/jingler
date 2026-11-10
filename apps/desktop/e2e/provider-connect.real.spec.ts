import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { MAIN_ENTRY } from "./global-setup.js";

// Drives the connect sheet against the operator's real, logged-in `claude` CLI:
// no pi fixture, the production entitlement probe, and only the `claude-cli`
// marker stored (Jingler never reads Claude credentials).
const enabled = process.env.JINGLER_REAL_CLAUDE_CONNECT === "1";
const ROUTE_LABEL = "Claude CLI subscription";
const PROVIDERS_NAV = /^Providers/u;

const freshHome = (): string => {
  const home = mkdtempSync(join(tmpdir(), "jingler-real-connect-"));
  const root = join(home, "jingler");
  const reposDir = join(home, "repos");
  const repo = join(reposDir, "canary");
  mkdirSync(root, { recursive: true });
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "--quiet", repo]);
  const now = new Date().toISOString();
  writeFileSync(join(root, "config.json"), JSON.stringify({ reposDir, lastRepoPath: repo, createdAt: now }));
  writeFileSync(
    join(root, "projects.json"),
    JSON.stringify([{ id: "p_canary", name: "canary", path: repo, availability: "available", createdAt: now, updatedAt: now }])
  );
  return home;
};

test.skip(!enabled, "Set JINGLER_REAL_CLAUDE_CONNECT=1 with a logged-in `claude` CLI (claude auth status).");

test("connects the real Claude CLI subscription through the connect sheet", async () => {
  test.setTimeout(5 * 60_000);
  const home = freshHome();
  const app = await electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${join(home, "chromium")}`],
    env: {
      ...process.env,
      ELECTRON_RENDERER_URL: "",
      JINGLER_DISABLE_AUTO_UPDATE: "1",
      JINGLER_E2E: "0",
      JINGLER_E2E_HEADLESS: process.env.JINGLER_E2E_HEADED === "1" ? "0" : "1",
      JINGLER_HOME: home,
      JINGLER_SCRIPTED_AGENT: "0",
      JINGLER_SECRET_STORE: "memory"
    }
  });
  try {
    const window = await app.firstWindow();
    const accountMenu = window.getByRole("button", { name: "Account menu" });
    await expect(accountMenu).toBeVisible({ timeout: 60_000 });
    await accountMenu.click();
    await window.getByRole("menuitem", { name: "Settings" }).click();
    await window.getByRole("button", { name: PROVIDERS_NAV }).click();

    await window.getByRole("button", { name: "Connect Claude Code", exact: true }).click();
    const sheet = window.getByRole("dialog");
    await expect(sheet.getByText("claude auth login").first()).toBeVisible();
    await sheet.getByRole("button", { name: "Connect with Claude Code" }).click();

    // The sheet closes on success; the real probe's account lands on the 15d card.
    await expect(sheet).toHaveCount(0, { timeout: 2 * 60_000 });
    await expect(window.getByText(ROUTE_LABEL, { exact: true }).first()).toBeVisible({ timeout: 60_000 });
    await expect(window.getByText("Add another account")).toBeVisible();
    await expect(window.getByText(/Reauthentication required/u)).toHaveCount(0);
  } finally {
    await app.close();
    rmSync(home, { recursive: true, force: true });
  }
});
