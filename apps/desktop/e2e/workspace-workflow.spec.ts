import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { addProject, appShell, expect, test } from "./fixtures.js"

test("approves setup, copied files, named Run/Stop, and archive cleanup", async ({ launchApp }) => {
  const launched = await launchApp({ configured: true, withRepo: true })
  const { window, repoPath, home } = launched
  await expect(appShell(window)).toBeVisible()
  appendFileSync(join(repoPath, ".gitignore"), "\n.env.local\n")
  writeFileSync(join(repoPath, ".env.local"), "WORKFLOW_COPY=ready\n")

  await window.getByTestId("new-session").click()
  await addProject(window, repoPath)
  await window.keyboard.press("Escape")

  await window.getByRole("button", { name: "Account menu" }).click()
  await window.getByRole("menuitem", { name: "Settings" }).click()
  await window.getByRole("button", { name: "Projects" }).click()
  await window.getByLabel("Setup command").fill("node -e \"require('node:fs').writeFileSync('setup-proof.txt','ready')\"")
  await window.getByLabel("Run commands").fill("Dev=node -e \"setInterval(()=>{},1000)\"")
  await window.getByLabel("Cleanup command").fill("node -e \"require('node:fs').writeFileSync('cleanup-proof.txt','done')\"")
  await window.getByLabel("Copied files").fill(".env.local")
  await window.getByRole("checkbox").check()
  await window.getByRole("button", { name: "Save workflow" }).click()
  await expect(window.getByText("Saved and approved for this exact content.")).toBeVisible()
  await window.getByRole("button", { name: "Close settings" }).click()

  await window.getByTestId("new-session").click()
  await window.getByRole("button", { name: "Create workspace" }).click()
  await expect(window.getByTestId("workspace-workflow-bar")).toBeVisible({ timeout: 20_000 })
  await expect(window.getByRole("button", { name: "Run Dev" })).toBeVisible()

  const sessionsPath = join(home, "jingler", "sessions.json")
  await expect.poll(() => existsSync(sessionsPath) ? JSON.parse(readFileSync(sessionsPath, "utf8"))[0]?.worktreePath : null).not.toBeNull()
  const session = JSON.parse(readFileSync(sessionsPath, "utf8"))[0] as { id: string; worktreePath: string }
  expect(readFileSync(join(session.worktreePath, "setup-proof.txt"), "utf8")).toBe("ready")
  expect(readFileSync(join(session.worktreePath, ".env.local"), "utf8")).toContain("WORKFLOW_COPY=ready")

  await window.getByRole("button", { name: "Run Dev" }).click()
  await expect(window.getByRole("button", { name: "Stop Dev" })).toBeVisible()
  // Remove a live definition: its original label and Stop control must survive.
  await window.getByRole("button", { name: "Account menu" }).click()
  await window.getByRole("menuitem", { name: "Settings" }).click()
  await window.getByRole("button", { name: "Projects" }).click()
  await window.getByLabel("Run commands").fill("Broken line")
  await window.getByRole("button", { name: "Save workflow" }).click()
  await expect(window.getByText(/Run command line 1 must use/)).toBeVisible()
  await window.getByLabel("Run commands").fill("Fail=node -e \"console.error('named failure proof');process.exit(7)\"")
  await window.getByRole("checkbox").check()
  await window.getByRole("button", { name: "Save workflow" }).click()
  await expect(window.getByText("Saved and approved for this exact content.")).toBeVisible()
  await window.getByRole("button", { name: "Close settings" }).click()
  await expect(window.getByRole("button", { name: "Stop Dev" })).toBeVisible()
  await window.getByRole("button", { name: "Stop Dev" }).click()
  await expect(window.getByRole("button", { name: "Stop Dev" })).not.toBeVisible({ timeout: 10_000 })
  await window.getByRole("button", { name: "Run Fail" }).click()
  await expect(window.getByText("Fail failed (exit 7)", { exact: true })).toBeVisible({ timeout: 10_000 })
  await window.getByText("Fail failed (exit 7)", { exact: true }).click()
  await expect(window.getByTestId("workspace-workflow-bar").getByText("named failure proof", { exact: true })).toBeVisible()

  const row = window.locator("[data-testid^='session-row-']").first()
  await row.hover()
  await row.getByRole("button", { name: /^Archive / }).click()
  await expect.poll(() => existsSync(join(session.worktreePath, "cleanup-proof.txt"))).toBe(true)
  await expect.poll(() => JSON.parse(readFileSync(sessionsPath, "utf8")).find((item: { id: string }) => item.id === session.id)?.archived).toBe(true)
})
