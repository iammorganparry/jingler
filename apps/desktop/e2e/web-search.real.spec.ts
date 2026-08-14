import { appShell, expect, test, type SeedSession } from "./fixtures.js"

const enabled = process.env.JINGLER_LIVE_WEB_SEARCH === "1"

const session = ({ repoPath }: { repoPath: string }): ReadonlyArray<SeedSession> => [{
  id: "s_live_web_search",
  repo: "widget",
  branch: "qa/live-web-search",
  title: "Live WebSearch QA",
  status: "idle",
  diff: { added: 0, removed: 0 },
  prNumber: null,
  costUsd: 0,
  tokens: 0,
  updatedAt: "2026-08-14T00:00:00.000Z",
  worktreePath: repoPath,
  mode: "auto"
}]

test.skip(!enabled, "Set JINGLER_LIVE_WEB_SEARCH=1 for operator-entered live provider QA")
test.setTimeout(7 * 60_000)

test("operator configures EXA and pi returns live cited WebSearch results", async ({
  launchApp
}) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: session,
    piFixture: { scenarioId: "live-web-search", authRoute: "api-key" }
  })

  await expect(appShell(window)).toBeVisible()
  await window.getByRole("button", { name: "Account menu" }).click()
  await window.getByRole("menuitem", { name: "Settings" }).click()
  await window.getByRole("button", { name: "General" }).click()

  const settings = window.getByRole("region", { name: "Web search" })
  await expect(settings).toBeVisible()
  console.log("LIVE_WEB_SEARCH_READY: enter the EXA key in Settings and click Save")
  await expect(settings.getByText(/Encrypted locally ·/)).toBeVisible({
    timeout: 5 * 60_000
  })
  await expect(settings.getByLabel("EXA API key")).toHaveValue("")

  await window.getByRole("button", { name: "Close settings" }).click()
  const composer = window.getByPlaceholder(/message/i)
  await composer.fill("Research Jingler using the live WebSearch provider.")
  await composer.press("Enter")

  const result = window.getByText(/Live WebSearch result:/).last()
  await expect(result).toBeVisible({ timeout: 60_000 })
  await expect(result).toContainText("Route: exa")
  await expect(result).toContainText(/Citations: https:\/\//)

  await window.getByRole("button", { name: "Account menu" }).click()
  await window.getByRole("menuitem", { name: "Settings" }).click()
  await window.getByRole("button", { name: "General" }).click()
  await settings.getByRole("button", { name: "Clear" }).click()
  await expect(settings.getByText("No saved key")).toBeVisible()
})
