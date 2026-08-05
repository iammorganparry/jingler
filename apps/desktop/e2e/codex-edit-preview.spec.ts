import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { appShell, expect, test } from "./fixtures.js"
import type { SeedSession } from "./fixtures.js"

const seededSessions = ({ repoPath }: { repoPath: string }): ReadonlyArray<SeedSession> => [
  {
    id: "s_codex_preview",
    repo: "widget",
    branch: "jingler/codex-preview",
    title: "Codex edit preview",
    status: "idle",
    cli: "codex",
    diff: { added: 0, removed: 0 },
    prNumber: null,
    costUsd: 0,
    tokens: 0,
    updatedAt: "2026-07-29T00:00:00.000Z",
    worktreePath: repoPath,
    mode: "auto",
    model: "gpt-5.6-sol"
  }
]

test("shows Codex update and create diffs inline", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: seededSessions
  })

  await expect(appShell(window)).toBeVisible()
  const composer = window.getByPlaceholder("Message Codex…")
  await composer.fill("[[codex-edit-preview]] Update the configuration.")
  await composer.press("Enter")

  await expect(window.getByText("Codex", { exact: true })).toBeVisible({ timeout: 20_000 })
  await expect(window.getByText("src/config.ts")).toBeVisible({ timeout: 20_000 })
  await expect(window.getByText("export const mode = 'legacy'", { exact: true })).toBeVisible()
  await expect(window.getByText("export const mode = 'modern'", { exact: true })).toBeVisible()
  await expect(window.getByText("+1 −1", { exact: true })).toBeVisible()

  await expect(window.getByText("src/created.ts")).toBeVisible()
  await expect(window.getByText("export const created = true", { exact: true })).toBeVisible()
  await expect(window.getByText("+1 −0", { exact: true })).toBeVisible()
})

test("opens a path Codex created after the initial workspace listing", async ({ launchApp }) => {
  const { window, repoPath } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: seededSessions
  })

  await expect(appShell(window)).toBeVisible()
  // Create this only after the conversation loaded its initial file list. The
  // null-diff Edit below is therefore the only signal that can make it openable.
  mkdirSync(join(repoPath, "reports"), { recursive: true })
  writeFileSync(
    join(repoPath, "reports", "codex-created.md"),
    "# Codex-created report\n\nOpened inside Jingler.\n"
  )

  const composer = window.getByPlaceholder("Message Codex…")
  await composer.fill("[[codex-open-created-file]] Create the report.")
  await composer.press("Enter")

  const absolutePath = join(repoPath, "reports", "codex-created.md")
  const link = window.getByTitle(`Open ${absolutePath}`, { exact: true })
  await expect(link).toBeVisible({ timeout: 20_000 })
  await link.click()
  await expect(window.getByRole("button", { name: "Hide preview" })).toBeVisible()
  // Markdown assets render in the native preview surface, outside Chromium's
  // DOM. The dock tab is the observable in-app proof that the created path
  // opened successfully.
  await expect(window.getByTitle("reports/codex-created.md", { exact: true })).toBeVisible({
    timeout: 20_000
  })
})
