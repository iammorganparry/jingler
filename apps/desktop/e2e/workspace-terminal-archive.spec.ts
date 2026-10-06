import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { addProject, appShell, expect, test } from "./fixtures.js"

test("warned ordinary-terminal archive preserves files and never runs cleanup", async ({ launchApp }) => {
  const { window, repoPath, home } = await launchApp({ configured: true, withRepo: true })
  await expect(appShell(window)).toBeVisible()
  await window.getByTestId("new-session").click(); await addProject(window, repoPath); await window.keyboard.press("Escape")
  await window.getByRole("button", { name: "Account menu" }).click()
  await window.getByRole("menuitem", { name: "Settings" }).click()
  await window.getByRole("button", { name: "Projects", exact: true }).click()
  await window.getByLabel("Cleanup command").fill("node -e \"require('node:fs').writeFileSync('cleanup-proof.txt','unsafe')\"")
  await window.getByLabel(/approve/i).first().check()
  await window.getByRole("button", { name: "Save workflow" }).click()
  await window.getByRole("button", { name: "Close settings" }).click()
  await window.getByTestId("new-session").click()
  await window.getByRole("button", { name: "Create workspace" }).click()
  await window.getByPlaceholder("Message the agent…").waitFor()
  const sessions = () => JSON.parse(readFileSync(join(home, "jingler/sessions.json"), "utf8"))
  await window.keyboard.press("Control+Backquote")
  await expect.poll(() => sessions()[0]?.checkpointPtyHistory).toBe(true)
  const cwd = sessions()[0].worktreePath
  writeFileSync(join(cwd, "preserve-me"), "preserved")
  const row = window.locator("[data-testid^='session-row-']").first(); await row.hover()
  await row.getByRole("button", { name: /^Archive / }).click()
  const dialog = window.getByRole("dialog", { name: "Archive without cleanup?" })
  await expect(dialog).toContainText("running jobs are preserved")
  expect(sessions()[0].archived).not.toBe(true)
  await dialog.getByRole("button", { name: "Archive without cleanup", exact: true }).click()
  await expect.poll(() => sessions()[0].archived).toBe(true)
  expect(readFileSync(join(cwd, "preserve-me"), "utf8")).toBe("preserved")
  expect(existsSync(join(cwd, "cleanup-proof.txt"))).toBe(false)
})
