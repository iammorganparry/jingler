import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { appShell, expect, type SeedSession, test } from "./fixtures.js"

const session = ({ repoPath }: { repoPath: string }): ReadonlyArray<SeedSession> => [{
  id: "s_tab_groups",
  repo: "widget",
  repoPath,
  branch: "main",
  title: "Grouped tabs",
  status: "idle",
  cli: "codex",
  diff: { added: 0, removed: 0 },
  prNumber: null,
  costUsd: 0,
  tokens: 0,
  updatedAt: "2026-08-09T00:00:00.000Z",
  worktreePath: repoPath,
  workspaceMode: "direct",
  mode: "auto"
}]

test("large chat and file sets collapse into independent tab groups", async ({ launchApp }) => {
  const launched = await launchApp({
    configured: true,
    withRepo: true,
    sessions: session,
    seed: ({ repoPath }) => {
      for (let index = 1; index <= 6; index += 1) {
        writeFileSync(join(repoPath, `file-${index}.ts`), `export const file${index} = true\n`)
      }
    }
  })
  const { window } = launched
  await expect(appShell(window)).toBeVisible()

  for (let index = 0; index < 3; index += 1) {
    await window.getByRole("button", { name: "New chat" }).click()
  }
  await expect(window.getByTitle("4 open chats")).toBeVisible()

  await window.getByRole("button", { name: "Files", exact: true }).click()
  const tree = window.locator('[aria-label="Repository files"]')
  await expect(tree).toBeVisible()
  for (let index = 1; index <= 6; index += 1) {
    const path = `file-${index}.ts`
    await tree.locator(`[role="treeitem"][data-item-path="${path}"]`).click()
    await expect(window.getByTestId(`file-tab-${path}`)).toBeVisible()
  }
  await expect(window.getByTitle("6 open files")).toBeVisible()

  await window.getByRole("button", { name: "Collapse chats group" }).click()
  await expect(window.getByTestId("chat-tab-chat-1")).toHaveCount(0)
  await expect(window.getByTestId("file-tab-file-6.ts")).toBeVisible()

  await window.getByRole("button", { name: "Collapse files group" }).click()
  await expect(window.getByTestId("file-tab-file-6.ts")).toHaveCount(0)
  await expect(window.getByRole("textbox", { name: "file-6.ts" })).toBeVisible()
  await expect(window.getByRole("button", { name: "Expand chats group" })).toBeVisible()
  await expect(window.getByRole("button", { name: "Expand files group" })).toBeVisible()
})
