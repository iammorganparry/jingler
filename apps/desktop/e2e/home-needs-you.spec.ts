/** Home needs-you card (#476): a pending question surfaces on Home once the pane is closed; Answer returns to the session. */
import { execFileSync } from "node:child_process"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { addProject, appShell, expect, test, type SeedSession } from "./fixtures.js"

const seededSessions = ({ repoPath }: { repoPath: string }): ReadonlyArray<SeedSession> => [
  {
    id: "s_home_needs_you",
    repo: "widget",
    branch: "feat/home",
    title: "Home needs-you",
    status: "idle",
    diff: { added: 0, removed: 0 },
    prNumber: null,
    costUsd: 0,
    tokens: 0,
    updatedAt: "2026-10-12T00:00:00.000Z",
    worktreePath: repoPath,
    mode: "accept-edits"
  }
]

test("Home shows a needs-you card for a pending question and Answer reopens the session", async ({ launchApp }) => {
  const { window, home } = await launchApp({ configured: true, withRepo: true, sessions: seededSessions })
  await expect(appShell(window)).toBeVisible()
  const composer = window.getByPlaceholder("Message the agent…")
  await composer.fill("[[ask]] migrate the store")
  await composer.press("Enter")
  await expect(window.getByText("Agent needs your input")).toBeVisible({ timeout: 15_000 })

  // Home is what an empty project shows: register a second, session-less project and open it.
  const otherPath = join(home, "home-empty-project")
  mkdirSync(otherPath, { recursive: true })
  execFileSync("git", ["init", "-b", "main"], { cwd: otherPath })
  execFileSync("git", ["-c", "user.email=e2e@example.com", "-c", "user.name=E2E", "commit", "--allow-empty", "-m", "initial"], { cwd: otherPath })
  await window.getByTestId("new-session").click()
  await addProject(window, otherPath)
  await window.getByRole("button", { name: "Close new session", exact: true }).click()
  await window.getByRole("navigation", { name: "Projects" }).getByRole("button", { name: "home-empty-project", exact: true }).click()
  const cards = window.getByTestId("home-cards")
  await expect(cards.getByText("Home needs-you", { exact: true })).toBeVisible()
  await expect(cards.getByText("Needs input", { exact: true })).toBeVisible()

  await cards.getByRole("button", { name: "Answer", exact: true }).click()
  await expect(window.getByText("Agent needs your input")).toBeVisible()
})
