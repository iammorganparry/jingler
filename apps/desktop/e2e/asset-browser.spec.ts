import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { appShell, expect, test } from "./fixtures.js"
import type { SeedSession } from "./fixtures.js"

const REPOSITORY_FILES = 1_200
const SOURCE_LINES = 5_000

const seeded = (worktreePath: string): SeedSession => ({
  id: "s_large_assets",
  repo: "widget",
  branch: "jingler/large-assets",
  title: "Large asset browser",
  status: "idle",
  cli: "claude",
  diff: { added: 0, removed: 0 },
  prNumber: null,
  costUsd: 0,
  tokens: 0,
  updatedAt: "2026-08-05T00:00:00.000Z",
  worktreePath
})

const transcript = [
  {
    id: "large-assets",
    role: "assistant",
    streaming: false,
    createdAt: "2026-08-05T00:00:00.000Z",
    parts: [
      {
        _tag: "Text",
        text: "Inspect the generated source in `src/huge.ts`."
      }
    ]
  }
]

test("keeps a large repository and source file windowed while navigating the persistent tree", async ({
  launchApp
}) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: ({ repoPath }) => [seeded(repoPath)],
    transcripts: { s_large_assets: transcript },
    seed: ({ repoPath }) => {
      mkdirSync(join(repoPath, "src"), { recursive: true })
      mkdirSync(join(repoPath, "generated"), { recursive: true })
      writeFileSync(
        join(repoPath, "src", "huge.ts"),
        `${Array.from(
          { length: SOURCE_LINES },
          (_, index) => `export const value_${String(index).padStart(4, "0")} = ${index}`
        ).join("\n")}\n`
      )
      for (let index = 0; index < REPOSITORY_FILES; index += 1) {
        writeFileSync(
          join(repoPath, "generated", `file-${String(index).padStart(4, "0")}.ts`),
          `export const generated = ${index}\n`
        )
      }
      execFileSync("git", ["add", "-A"], { cwd: repoPath })
      execFileSync("git", ["commit", "-m", "large assets", "--no-gpg-sign"], {
        cwd: repoPath
      })
    }
  })

  await expect(appShell(window)).toBeVisible()
  await window.getByTitle("Open src/huge.ts").click()
  await expect(window.getByText("export const value_0000 = 0", { exact: true })).toBeVisible({
    timeout: 30_000
  })

  const mountedSourceLines = await window
    .locator('diffs-container [data-line][data-line-index]')
    .count()
  expect(mountedSourceLines).toBeGreaterThan(0)
  expect(mountedSourceLines).toBeLessThan(SOURCE_LINES)

  const previewControls = window.getByRole("button", { name: "Hide preview" }).locator("..")
  await previewControls.getByRole("button", { name: "Dock bottom" }).click()
  const tree = window.locator(
    '[data-jingler-pierre-file-tree][aria-label="Repository files"]'
  )
  await expect(tree).toBeVisible()
  await tree.evaluate((element) => element.setAttribute("data-s4-tree", "persistent"))

  const huge = tree.locator('[role="treeitem"][data-item-path="src/huge.ts"]')
  await expect(huge).toBeVisible({ timeout: 30_000 })
  const mountedTreeItems = await tree.locator('[role="treeitem"]').count()
  expect(mountedTreeItems).toBeGreaterThan(0)
  expect(mountedTreeItems).toBeLessThan(REPOSITORY_FILES)

  await huge.focus()
  await huge.press("f")
  const search = tree.locator("[data-file-tree-search-input]")
  await expect(search).toBeVisible()
  await search.fill("file-1199.ts")
  await search.press("Enter")

  await expect(window.getByTitle("generated/file-1199.ts", { exact: true })).toBeVisible({
    timeout: 15_000
  })
  await expect(window.getByText("export const generated = 1199", { exact: true })).toBeVisible({
    timeout: 15_000
  })
  await expect(tree).toHaveAttribute("data-s4-tree", "persistent")
  await expect(tree.locator('[data-item-path="generated/file-1199.ts"]')).toHaveAttribute(
    "aria-selected",
    "true"
  )
})
