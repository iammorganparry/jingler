import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Page } from "@playwright/test"
import { appShell, createWorkspace, expect, test } from "./fixtures.js"

interface PersistedCheckout {
  readonly id: string
  readonly repo: string
  readonly worktreePath?: string
}
interface PersistedSession {
  readonly worktreePath: string
  readonly repo: string
  readonly repoPath: string
  readonly checkouts?: ReadonlyArray<PersistedCheckout>
  readonly archived?: boolean
}

const git = (cwd: string, args: ReadonlyArray<string>): string =>
  execFileSync("git", [...args], { cwd, encoding: "utf8" }).trim()

const sessionsAt = (home: string): ReadonlyArray<PersistedSession> =>
  JSON.parse(readFileSync(join(home, "jingler", "sessions.json"), "utf8")) as ReadonlyArray<PersistedSession>

const makeRepo = (dir: string): void => {
  mkdirSync(dir, { recursive: true })
  git(dir, ["init", "-b", "main"])
  git(dir, ["config", "user.email", "e2e@jingler.dev"])
  git(dir, ["config", "user.name", "Jingler E2E"])
  git(dir, ["config", "commit.gpgsign", "false"])
  writeFileSync(join(dir, "README.md"), "# gadget\n")
  git(dir, ["add", "-A"])
  git(dir, ["commit", "-m", "init", "--no-gpg-sign"])
}

const projectRecord = (id: string, name: string, path: string) => ({
  id, name, path, imported: true, availability: "available", createdAt: "2026-01-01", updatedAt: "2026-01-01"
})

/** Two fixture repos; `registerSecond` decides whether the second is a known project. */
const launchTwoRepos = (
  launchApp: Parameters<Parameters<typeof test>[2]>[0]["launchApp"],
  registerSecond: boolean
) => {
  let secondPath = ""
  const launched = launchApp({
    configured: true,
    withRepo: true,
    seed: ({ home, reposDir, repoPath }) => {
      secondPath = join(reposDir, "gadget")
      makeRepo(secondPath)
      mkdirSync(join(home, "jingler"), { recursive: true })
      writeFileSync(
        join(home, "jingler", "projects.json"),
        JSON.stringify([
          projectRecord("p-widget", "widget", repoPath),
          ...(registerSecond ? [projectRecord("p-gadget", "gadget", secondPath)] : [])
        ])
      )
    }
  })
  return launched.then((app) => ({ ...app, secondPath }))
}

/** The session may start on either project; switch to whichever repo it is not on. */
const startSwitchTurn = async (window: Page, home: string, repoPath: string, secondPath: string): Promise<string> => {
  await expect.poll(() => sessionsAt(home)[0]?.repoPath, { timeout: 20_000 }).toBeTruthy()
  const target = sessionsAt(home)[0]!.repoPath === secondPath ? repoPath : secondPath
  const composer = window.getByPlaceholder("Message the agent…")
  await composer.fill(`[[switch-repo=${target}]] work in the second repo`)
  await composer.press("Enter")
  return target
}

/** Approve every gate the turn raises (the write is gated in ask mode). */
const allowGates = async (window: Page, until: () => Promise<boolean>): Promise<void> => {
  await expect
    .poll(async () => {
      const allow = window.getByRole("button", { name: /Allow once/ }).first()
      if (await allow.isVisible().catch(() => false)) await allow.click().catch(() => undefined)
      return until()
    }, { timeout: 40_000 })
    .toBe(true)
}

test("agent switches to a second registered repo mid-turn; Changes groups both; delete removes both worktrees", async ({ launchApp }) => {
  const { window, home, repoPath, secondPath } = await launchTwoRepos(launchApp, true)
  await expect(appShell(window)).toBeVisible()
  await createWorkspace(window, "Multi repo", "worktree", repoPath)
  await expect(window.locator("[data-testid^='session-row-']")).toHaveCount(1)

  await startSwitchTurn(window, home, repoPath, secondPath)
  await expect(window.getByText("Switched to", { exact: false }).first()).toBeVisible({ timeout: 40_000 })
  await expect(window.getByText("Edited the second repository.")).toBeVisible({ timeout: 40_000 })
  await allowGates(window, async () =>
    existsSync(join(sessionsAt(home)[0]?.checkouts?.[1]?.worktreePath ?? "/missing", "src", "other-repo.ts"))
  )

  const session = sessionsAt(home)[0]!
  expect(session.checkouts).toHaveLength(2)
  const [first, second] = session.checkouts!
  // The write landed in repo B's worktree, never repo A's.
  expect(existsSync(join(first!.worktreePath!, "src", "other-repo.ts"))).toBe(false)

  // Header switcher and the sidebar repo count.
  await expect(window.getByTestId("checkout-switcher")).toBeVisible()
  await expect(window.getByTestId(`session-repos-${(session as unknown as { id: string }).id}`)).toContainText(" + ")

  // Changes: both repos grouped by checkout.
  await window.getByRole("button", { name: /^Changes\b/ }).first().click()
  await expect(window.getByTestId(`changes-checkout-${first!.id}`)).toBeVisible({ timeout: 20_000 })
  await expect(window.getByTestId(`changes-checkout-${second!.id}`).locator('[data-item-path="src/other-repo.ts"]')).toBeVisible({ timeout: 20_000 })
  await expect(window.getByTestId(`changes-checkout-${first!.id}`).locator('[data-item-path="src/other-repo.ts"]')).toHaveCount(0)

  // Deleting the session removes every worktree it owns.
  await window.getByRole("tab", { name: "Sessions" }).click()
  const row = window.locator("[data-testid^='session-row-']").first()
  await row.hover()
  await row.getByRole("button", { name: /^Delete / }).click()
  await window.getByRole("dialog").getByRole("button", { name: "Delete" }).click()
  await expect.poll(() => sessionsAt(home).length, { timeout: 30_000 }).toBe(0)
  await expect.poll(() => existsSync(first!.worktreePath!), { timeout: 30_000 }).toBe(false)
  await expect.poll(() => existsSync(second!.worktreePath!), { timeout: 30_000 }).toBe(false)
})

test("group header and checkout chip show the checkout's live branch after the agent moves it (Q7)", async ({ launchApp }) => {
  const { window, home, repoPath, secondPath } = await launchTwoRepos(launchApp, true)
  await expect(appShell(window)).toBeVisible()
  await createWorkspace(window, "Live branch", "worktree", repoPath)
  await expect(window.locator("[data-testid^='session-row-']")).toHaveCount(1)
  await expect.poll(() => sessionsAt(home)[0]?.repoPath, { timeout: 20_000 }).toBeTruthy()
  const target = sessionsAt(home)[0]!.repoPath === secondPath ? repoPath : secondPath

  const composer = window.getByPlaceholder("Message the agent…")
  await composer.fill(`[[switch-repo=${target}]] [[checkout-branch=feat/live-label]] move it`)
  await composer.press("Enter")
  await expect(window.getByText("Moved the checkout.")).toBeVisible({ timeout: 60_000 })
  await allowGates(window, async () => (sessionsAt(home)[0]?.checkouts ?? []).some((c) => (c as { branch?: string }).branch === "feat/live-label"))

  const moved = sessionsAt(home)[0]!.checkouts!.find((c) => (c as { branch?: string }).branch === "feat/live-label")!
  await expect(window.getByTestId("checkout-switcher")).toContainText("feat/live-label")
  await window.getByRole("button", { name: /^Changes\b/ }).first().click()
  await expect(window.getByTestId(`changes-checkout-${moved.id}`)).toContainText("feat/live-label", { timeout: 20_000 })
})

test("an unregistered repo asks for approval: approve registers and attaches", async ({ launchApp }) => {
  const { window, home, repoPath, secondPath } = await launchTwoRepos(launchApp, false)
  await expect(appShell(window)).toBeVisible()
  await createWorkspace(window, "Approve repo", "worktree", repoPath)
  await expect(window.locator("[data-testid^='session-row-']")).toHaveCount(1)

  await startSwitchTurn(window, home, repoPath, secondPath)
  await expect(window.getByText("Attach an unregistered repository?")).toBeVisible({ timeout: 40_000 })
  await window.getByRole("button", { name: /Allow once/ }).first().click()
  await expect.poll(() => sessionsAt(home)[0]?.checkouts?.length, { timeout: 40_000 }).toBe(2)
  const projects = JSON.parse(readFileSync(join(home, "jingler", "projects.json"), "utf8")) as Array<{ path: string }>
  expect(projects.map((project) => project.path)).toContain(secondPath)
})

test("denying the approval leaves the session unchanged", async ({ launchApp }) => {
  const { window, home, repoPath, secondPath } = await launchTwoRepos(launchApp, false)
  await expect(appShell(window)).toBeVisible()
  await createWorkspace(window, "Deny repo", "worktree", repoPath)
  await expect(window.locator("[data-testid^='session-row-']")).toHaveCount(1)

  await startSwitchTurn(window, home, repoPath, secondPath)
  await expect(window.getByText("Attach an unregistered repository?")).toBeVisible({ timeout: 40_000 })
  await window.getByRole("button", { name: "Deny" }).first().click()
  await expect(window.getByText("Attach an unregistered repository?")).toBeVisible()
  const projects = JSON.parse(readFileSync(join(home, "jingler", "projects.json"), "utf8")) as Array<{ path: string }>
  expect(projects.map((project) => project.path)).not.toContain(secondPath)
  expect(sessionsAt(home)[0]?.checkouts?.length ?? 1).toBe(1)
})
