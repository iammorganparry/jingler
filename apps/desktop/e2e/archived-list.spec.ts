import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { addProject, appShell, expect, test } from "./fixtures.js"

test("archiving a merged session removes its worktree but keeps it under Archived", async ({ launchApp }) => {
  const { window, repoPath, home } = await launchApp({ configured: true, withRepo: true })
  // A pushed base branch is what makes the fresh worktree's HEAD "pushed".
  const remote = join(home, "remote.git")
  execFileSync("git", ["init", "--bare", "-b", "main", remote])
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: repoPath })
  execFileSync("git", ["push", "-u", "origin", "main"], { cwd: repoPath })

  await expect(appShell(window)).toBeVisible()
  await window.getByTestId("new-session").click(); await addProject(window, repoPath); await window.keyboard.press("Escape")
  await window.getByTestId("new-session").click()
  await window.getByRole("button", { name: "Create workspace" }).click()
  await window.getByPlaceholder("Message the agent…").waitFor()
  const sessions = () => JSON.parse(readFileSync(join(home, "jingler/sessions.json"), "utf8"))
  const worktreePath: string = sessions()[0].worktreePath
  expect(existsSync(worktreePath)).toBe(true)

  const row = window.locator("[data-testid^='session-row-']").first(); await row.hover()
  await row.getByRole("button", { name: /^Archive / }).click()

  await expect.poll(() => sessions()[0]?.archived).toBe(true)
  await expect.poll(() => existsSync(worktreePath)).toBe(false)
  expect(sessions()[0].worktreeKeptReason).toBeUndefined()
})
