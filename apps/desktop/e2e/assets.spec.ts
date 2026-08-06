import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Page } from "@playwright/test"
import { appShell, expect, test } from "./fixtures.js"
import type { SeedSession } from "./fixtures.js"

/**
 * Repository files are a session view, not Preview content. These scenarios
 * drive the real Asset RPC + Pierre editor path against a disposable worktree.
 */

const git = (cwd: string, args: ReadonlyArray<string>): void => {
  execFileSync("git", args, { cwd, stdio: "ignore" })
}

const seedAssets = ({ repoPath }: { repoPath: string }): void => {
  mkdirSync(join(repoPath, "docs"), { recursive: true })
  mkdirSync(join(repoPath, "out"), { recursive: true })
  mkdirSync(join(repoPath, "src"), { recursive: true })
  writeFileSync(join(repoPath, "docs", "spec.md"), "# The Spec\n\nA **bold** claim.\n")
  writeFileSync(join(repoPath, "out", "results.csv"), "name,count\nalpha,12\nbeta,7\n")
  writeFileSync(join(repoPath, "src", "main.ts"), "export const answer = 42\n")
  writeFileSync(join(repoPath, "README.custom"), "extension-free text is editable\n")
  writeFileSync(join(repoPath, "archive.bin"), Buffer.from([0, 159, 146, 150, 0, 255]))
  git(repoPath, ["add", "-A"])
  git(repoPath, ["commit", "-m", "files", "--no-gpg-sign"])
  // Files created by the agent this turn are usually untracked and must still
  // appear in the session browser and transcript link gate.
  writeFileSync(join(repoPath, "notes.md"), "# Fresh Notes\n")
  writeFileSync(join(repoPath, ".gitignore"), "ignored.md\n")
  writeFileSync(join(repoPath, "ignored.md"), "# Ignored\n")
}

const session = (worktreePath: string): SeedSession => ({
  id: "s_files",
  repo: "widget",
  branch: "jingler/files",
  title: "Edit repository files",
  status: "idle",
  cli: "claude",
  diff: { added: 0, removed: 0 },
  prNumber: null,
  costUsd: 0,
  tokens: 0,
  updatedAt: "2026-08-05T00:00:00.000Z",
  worktreePath,
  mode: "accept-edits"
})

const transcript = [
  {
    id: "a_write",
    role: "assistant",
    streaming: false,
    createdAt: "2026-08-05T00:00:00.000Z",
    parts: [
      {
        _tag: "Tool",
        tool: {
          id: "t_write",
          name: "Write",
          target: "docs/spec.md",
          status: "success",
          meta: null,
          diff: null,
          preview: null
        }
      },
      {
        _tag: "Text",
        text: [
          "See `out/results.csv` and [the spec](./docs/spec.md).",
          "Fresh output is in `notes.md`; ignored output is in `ignored.md`."
        ].join("\n\n")
      }
    ]
  }
]

const filesTab = (window: Page) =>
  window.getByRole("button", { name: "Files", exact: true })
const conversationTab = (window: Page) =>
  window.getByRole("button", { name: "Chat 1", exact: true })
const tree = (window: Page) =>
  window.locator('[data-jingler-pierre-file-tree][aria-label="Repository files"]')
const showTree = async (window: Page): Promise<void> => {
  const toggle = window.getByRole("button", { name: "Repository files", exact: true })
  if ((await toggle.count()) > 0 && (await toggle.getAttribute("aria-expanded")) !== "true") {
    await toggle.click()
  }
  await expect(tree(window)).toBeVisible()
}

test("routes every transcript file gesture to Files and keeps Preview browser-only", async ({
  launchApp
}) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    seed: seedAssets,
    sessions: ({ repoPath }) => [session(repoPath)],
    transcripts: { s_files: transcript }
  })

  await expect(appShell(window)).toBeVisible()

  // Tool filename → Files.
  await window.getByTitle("Open spec.md").click()
  await expect(filesTab(window)).toHaveAttribute("aria-current", "page")
  await expect(window.getByRole("heading", { name: "The Spec" })).toBeVisible({
    timeout: 15_000
  })
  await window.getByRole("button", { name: "Edit", exact: true }).click()
  await expect(window.getByRole("textbox", { name: "docs/spec.md" })).toBeVisible({
    timeout: 15_000
  })
  await showTree(window)

  // Inline code path → the same Files view.
  await conversationTab(window).click()
  await window.getByTitle("Open out/results.csv").click()
  await expect(window.getByText("alpha", { exact: true })).toBeVisible({ timeout: 15_000 })
  await window.getByRole("button", { name: "Edit", exact: true }).click()
  await expect(window.getByRole("textbox", { name: "out/results.csv" })).toBeVisible({
    timeout: 15_000
  })

  // Relative markdown link → the same Files view.
  await conversationTab(window).click()
  await window.getByRole("button", { name: "the spec" }).click()
  await expect(window.getByRole("heading", { name: "The Spec" })).toBeVisible({
    timeout: 15_000
  })

  // Untracked files remain navigable; ignored files do not become gestures.
  await conversationTab(window).click()
  await window.getByTitle("Open notes.md").click()
  await expect(window.getByRole("heading", { name: "Fresh Notes" })).toBeVisible({
    timeout: 15_000
  })
  await conversationTab(window).click()
  await expect(window.getByTitle("Open ignored.md")).toHaveCount(0)

  // The internet browser is a separate dock, with its own address bar and no
  // file-tab close chrome. Opening it does not replace the session tab model.
  const preview = window.getByRole("button", { name: "Preview", exact: true })
  if ((await preview.getAttribute("aria-pressed")) !== "true") await preview.click()
  const browser = window.getByLabel("Browser preview")
  await expect(browser.getByLabel("Preview URL")).toBeVisible()
  await expect(browser.getByText("Browser", { exact: true })).toBeVisible()
  await expect(browser.getByRole("button", { name: /^Close .+\.(md|csv|ts)$/ })).toHaveCount(0)
})

test("edits and saves text, retains drafts across tabs, and preserves conflicts", async ({
  launchApp
}) => {
  const { window, repoPath } = await launchApp({
    configured: true,
    withRepo: true,
    seed: seedAssets,
    sessions: ({ repoPath }) => [session(repoPath)]
  })

  await expect(appShell(window)).toBeVisible()
  await filesTab(window).click()
  await showTree(window)
  const source = tree(window).locator('[data-item-path="src/main.ts"]')
  await expect(source).toBeVisible({ timeout: 15_000 })
  await source.click()

  let editor = window.getByRole("textbox", { name: "src/main.ts" })
  await expect(editor).toContainText("export const answer = 42", { timeout: 15_000 })
  await editor.click()
  await editor.press("Meta+a")
  await window.keyboard.insertText("export const answer = 43\n")
  await expect(window.getByText("Unsaved", { exact: true })).toBeVisible()

  // Switching the session tab unmounts the view, but not its session actor.
  await conversationTab(window).click()
  await filesTab(window).click()
  editor = window.getByRole("textbox", { name: "src/main.ts" })
  await expect(editor).toContainText("export const answer = 43", { timeout: 15_000 })
  await expect(window.getByText("Unsaved", { exact: true })).toBeVisible()

  await window.getByRole("button", { name: "Save", exact: true }).click()
  await expect(window.getByText("Saved", { exact: true })).toBeVisible({ timeout: 15_000 })
  await expect.poll(() => readFileSync(join(repoPath, "src", "main.ts"), "utf8")).toBe(
    "export const answer = 43\n"
  )

  // A later agent write wins on disk. The stale user save becomes a visible,
  // non-destructive conflict and keeps the user's draft while refreshing the
  // revision needed for a deliberate follow-up save.
  editor = window.getByRole("textbox", { name: "src/main.ts" })
  await editor.click()
  await editor.press("Meta+a")
  await window.keyboard.insertText("export const answer = 44\n")
  await expect(window.getByText("Unsaved", { exact: true })).toBeVisible()
  writeFileSync(join(repoPath, "src", "main.ts"), "export const answer = 99\n")

  await window.getByRole("button", { name: "Save", exact: true }).click()
  await expect(window.getByText("Conflict", { exact: true })).toBeVisible({ timeout: 15_000 })
  await expect(window.getByText(/Your draft is still here/)).toBeVisible()
  await expect(editor).toContainText("export const answer = 44")
  expect(readFileSync(join(repoPath, "src", "main.ts"), "utf8")).toBe(
    "export const answer = 99\n"
  )

  await window.getByRole("button", { name: "Refresh revision", exact: true }).click()
  editor = window.getByRole("textbox", { name: "src/main.ts" })
  await expect(editor).toContainText("export const answer = 44", { timeout: 15_000 })
  await expect(window.getByText("Conflict", { exact: true })).toHaveCount(0)
  await expect(window.getByText("Unsaved", { exact: true })).toBeVisible()
  await window.getByRole("button", { name: "Save", exact: true }).click()
  await expect(window.getByText("Saved", { exact: true })).toBeVisible({ timeout: 15_000 })
  await expect.poll(() => readFileSync(join(repoPath, "src", "main.ts"), "utf8")).toBe(
    "export const answer = 44\n"
  )
})

test("edits UTF-8 files with unknown extensions and refuses binary data", async ({
  launchApp
}) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    seed: seedAssets,
    sessions: ({ repoPath }) => [session(repoPath)]
  })

  await expect(appShell(window)).toBeVisible()
  await filesTab(window).click()
  await showTree(window)
  await tree(window).locator('[data-item-path="README.custom"]').click()
  await expect(window.getByRole("textbox", { name: "README.custom" })).toContainText(
    "extension-free text is editable",
    { timeout: 15_000 }
  )

  await showTree(window)
  await tree(window).locator('[data-item-path="archive.bin"]').click()
  await expect(window.getByText("Binary file", { exact: true })).toBeVisible({ timeout: 15_000 })
  await expect(window.getByRole("button", { name: "Save", exact: true })).toHaveCount(0)
})
