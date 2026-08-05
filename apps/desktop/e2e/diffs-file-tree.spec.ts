import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Page } from "@playwright/test"
import { appShell, expect, sessionRow, test } from "./fixtures.js"
import type { SeedSession } from "./fixtures.js"

const seeded = (worktreePath: string): SeedSession => ({
  id: "s_pierre_review",
  repo: "widget",
  branch: "jingler/pierre-review",
  title: "Pierre review session",
  status: "idle",
  cli: "claude",
  diff: { added: 2, removed: 2 },
  prNumber: null,
  costUsd: 0,
  tokens: 0,
  updatedAt: "2026-08-05T00:00:00.000Z",
  worktreePath
})

const openFileRail = async (window: Page): Promise<void> => {
  const rail = window.getByTestId("review-file-rail")
  if (await rail.isVisible()) return
  await window.getByRole("button", { name: "Changed files" }).click()
  await expect(rail).toBeVisible()
}

test("navigates a hierarchical Pierre review tree and reverts a selected new-side line", async ({
  launchApp
}) => {
  let loginPath = ""
  const original = "export const login = oldLogin\nexport const stable = true\n"
  const changed = "export const login = nextLogin\nexport const stable = true\n"
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: ({ repoPath }) => [seeded(repoPath)],
    seed: ({ repoPath }) => {
      mkdirSync(join(repoPath, "src", "auth"), { recursive: true })
      mkdirSync(join(repoPath, "src", "store"), { recursive: true })
      loginPath = join(repoPath, "src", "auth", "login.ts")
      writeFileSync(loginPath, original)
      writeFileSync(join(repoPath, "src", "store", "cache.ts"), "export const ttl = 30\n")
      execFileSync("git", ["add", "-A"], { cwd: repoPath })
      execFileSync("git", ["commit", "-m", "seed review", "--no-gpg-sign"], {
        cwd: repoPath
      })
      writeFileSync(loginPath, changed)
      writeFileSync(join(repoPath, "src", "store", "cache.ts"), "export const ttl = 60\n")
    }
  })

  await expect(appShell(window)).toBeVisible()
  await sessionRow(window, "Pierre review session").click()
  await window.getByRole("button", { name: "Changes" }).first().click()
  await openFileRail(window)

  const tree = window.locator(
    '[data-jingler-pierre-file-tree][aria-label="Changed files tree"]'
  )
  await expect(tree).toBeVisible({ timeout: 30_000 })
  await expect(tree.locator('[role="treeitem"][data-item-path="src/"]')).toHaveAttribute(
    "data-item-type",
    "folder"
  )
  await expect(tree.locator('[role="treeitem"][data-item-path="src/auth/"]')).toHaveAttribute(
    "data-item-type",
    "folder"
  )

  const login = tree.locator('[data-item-path="src/auth/login.ts"]')
  await expect(login).toHaveAttribute("data-item-git-status", "modified")
  await login.click()
  await expect(login).toHaveAttribute("aria-selected", "true")
  const rail = window.getByTestId("review-file-rail")
  const filesButton = window.getByRole("button", { name: "Changed files" })
  if (await rail.isVisible() && await filesButton.isVisible()) {
    await filesButton.click()
    await expect(rail).toBeHidden()
  }
  await expect(window.getByText("export const login = nextLogin", { exact: true })).toBeVisible({
    timeout: 30_000
  })

  const diff = window.locator("diffs-container").filter({
    hasText: "export const login = nextLogin"
  })
  const addedLine = diff
    .locator('[data-line-type="change-addition"][data-column-number="1"]')
    .first()
  await expect(addedLine).toBeVisible()
  await addedLine.click({ position: { x: 6, y: 6 } })

  await expect(window.getByText("login.ts new L1", { exact: true })).toBeVisible()
  await expect(
    window.getByPlaceholder("Suggest a change or ask the agent to fix this…")
  ).toBeVisible()
  await window.getByRole("button", { name: "Revert L1" }).click()

  await expect.poll(() => readFileSync(loginPath, "utf8")).toBe(original)
  await expect(window.getByText("export const login = nextLogin", { exact: true })).toHaveCount(0, {
    timeout: 30_000
  })
  await expect(
    window.getByPlaceholder("Suggest a change or ask the agent to fix this…")
  ).toHaveCount(0)
  await expect(tree.locator('[data-item-path="src/store/cache.ts"]')).toHaveAttribute(
    "data-item-git-status",
    "modified"
  )
})
