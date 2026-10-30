import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { appShell, expect, openSessionByTitle, test } from "./fixtures.js"

const git = (cwd: string, args: ReadonlyArray<string>) => execFileSync("git", [...args], { cwd, encoding: "utf8" })

const makeRepo = (dir: string) => {
  mkdirSync(dir, { recursive: true })
  git(dir, ["init", "-b", "main"])
  git(dir, ["config", "user.email", "e2e@jingler.dev"])
  git(dir, ["config", "user.name", "Jingler E2E"])
  writeFileSync(join(dir, "README.md"), "# base\n")
  git(dir, ["add", "-A"])
  git(dir, ["commit", "-m", "init", "--no-gpg-sign"])
}

test("a file opened from the non-active repo's Changes group shows that repo's diff", async ({ launchApp }) => {
  let apiPath = ""
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    seed: ({ reposDir, repoPath }) => {
      apiPath = join(reposDir, "api")
      makeRepo(apiPath)
      writeFileSync(join(repoPath, "README.md"), "# e2e repo\nWEB_ONLY_LINE\n")
      writeFileSync(join(apiPath, "README.md"), "# base\nAPI_ONLY_LINE\n")
    },
    sessions: ({ reposDir, repoPath }) => [{
      id: "s_probe", repo: "widget", branch: "main", title: "probe multi",
      status: "idle" as const, diff: { added: 0, removed: 0 }, prNumber: null,
      checkouts: [
        { id: "web", repo: "widget", branch: "main", prNumber: null, worktreePath: repoPath, repoPath, workspaceMode: "direct", baseBranch: "main" },
        { id: "api", repo: "api", branch: "main", prNumber: null, worktreePath: join(reposDir, "api"), repoPath: join(reposDir, "api"), workspaceMode: "direct", baseBranch: "main" }
      ],
      activeCheckoutId: "web", costUsd: 0, tokens: 0,
      updatedAt: "2026-07-24T10:00:00.000Z", worktreePath: repoPath, repoPath
    }]
  })
  await expect(appShell(window)).toBeVisible()
  await openSessionByTitle(window, "probe multi")
  await window.getByRole("button", { name: /^Changes\b/ }).first().click()
  const apiGroup = window.getByTestId("changes-checkout-api")
  await expect(apiGroup.locator('[data-item-path="README.md"]')).toBeVisible({ timeout: 20_000 })
  await apiGroup.locator('[data-item-path="README.md"]').click()
  await expect(window.getByText("API_ONLY_LINE").first()).toBeVisible({ timeout: 15_000 })
  await expect(window.getByText("WEB_ONLY_LINE")).toHaveCount(0)
  await window.getByRole("button", { name: /^Changes\b/ }).first().click()
  const webGroup = window.getByTestId("changes-checkout-web")
  await webGroup.locator('[data-item-path="README.md"]').click()
  await expect(window.getByText("WEB_ONLY_LINE").first()).toBeVisible({ timeout: 15_000 })
})
