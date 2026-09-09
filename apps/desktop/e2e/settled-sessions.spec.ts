import { appShell, expect, sessionRow, test, type SeedSession } from "./fixtures.js"

const SESSION_ID = "s_settled"
const sessions = ({ repoPath }: { readonly repoPath: string }): ReadonlyArray<SeedSession> => [{
  id: SESSION_ID,
  repo: "widget",
  branch: "main",
  title: "Settled lifecycle",
  status: "idle",
  diff: { added: 0, removed: 0 },
  prNumber: null,
  costUsd: 0,
  tokens: 0,
  updatedAt: "2026-09-08T12:00:00.000Z",
  worktreePath: repoPath
}]

const send = async (window: Parameters<typeof sessionRow>[0], text: string) => {
  const composer = window.getByPlaceholder("Message the agent…")
  await composer.fill(text)
  await composer.press("Enter")
}

test("persists Settled across restart and reopens on follow-up", async ({ launchApp }) => {
  const first = await launchApp({ configured: true, withRepo: true, sessions })
  const { window } = first
  await expect(appShell(window)).toBeVisible()
  const skipImport = window.getByRole("button", { name: "Skip import" })
  if (await skipImport.isVisible()) await skipImport.click()
  const terminalClose = window.getByRole("button", { name: "Close zsh" })
  if (await terminalClose.isVisible()) await terminalClose.click()
  await sessionRow(window, "Settled lifecycle").click()
  const row = window.getByTestId(`session-row-${SESSION_ID}`)

  await send(window, "Answer without declaring completion.")
  await expect(row.locator('[title="Idle"]')).toBeVisible({ timeout: 20_000 })
  await expect(row.locator('[title="Settled"]')).toHaveCount(0)

  await send(window, "[[complete-session]]")
  await expect(row.locator('[title="Settled"]')).toBeVisible({ timeout: 20_000 })

  await first.app.close()
  const reopened = await launchApp({
    configured: true, withRepo: true,
    home: first.home, reposDir: first.reposDir, userDataDir: first.userDataDir,
    authServer: first.authServer, githubServer: first.githubServer, githubRelay: first.githubRelay
  })
  await expect(appShell(reopened.window)).toBeVisible()
  await sessionRow(reopened.window, "Settled lifecycle").click()
  const restoredRow = reopened.window.getByTestId(`session-row-${SESSION_ID}`)
  await expect(restoredRow.locator('[title="Settled"]')).toBeVisible({ timeout: 20_000 })
  await send(reopened.window, "New follow-up work.")
  await expect(restoredRow.locator('[title="Idle"]')).toBeVisible({ timeout: 20_000 })
  await expect(restoredRow.locator('[title="Settled"]')).toHaveCount(0)
})
