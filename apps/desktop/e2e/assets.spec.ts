import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Locator, Page } from "@playwright/test"
import { appShell, expect, test } from "./fixtures.js"
import { explorerTree } from "./explorer.js"
import type { SeedSession } from "./fixtures.js"

const HIGHLIGHTER_LANGUAGE_ERROR = /Grammar for language|resolveLanguage/u

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
  writeFileSync(join(repoPath, "src", "edit.ts"), "export const editable = 42\n")
  writeFileSync(join(repoPath, "README.custom"), "extension-free text is editable\n")
  writeFileSync(join(repoPath, "archive.bin"), Buffer.from([0, 159, 146, 150, 0, 255]))
  git(repoPath, ["add", "-A"])
  git(repoPath, ["commit", "-m", "files", "--no-gpg-sign"])
  writeFileSync(join(repoPath, "src", "main.ts"), "export const answer = 43\n")
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
  window.getByRole("tab", { name: "Chat 1", exact: true }).first()
// The sidebar Explorer's tree; the Files view keeps a hidden one mounted too.
const tree = (window: Page) =>
  window
    .locator('[data-jingler-pierre-file-tree][aria-label="Repository files"]')
    .filter({ visible: true })
    .first()
const showTree = async (window: Page): Promise<void> => {
  await explorerTree(window)
}
const selectTreePath = async (window: Page, path: string): Promise<void> => {
  const host = tree(window)
  const target = host.locator(`[role="treeitem"][data-item-path="${path}"]`)
  for (let attempt = 0; attempt < 24; attempt += 1) {
    if ((await target.count()) > 0 && (await target.isVisible())) {
      await target.click()
      return
    }
    const collapsed = host.locator('[role="treeitem"][aria-expanded="false"]')
    const count = await collapsed.count()
    let expanded = false
    for (let index = 0; index < count; index += 1) {
      const candidate = collapsed.nth(index)
      const candidatePath = await candidate.getAttribute("data-item-path")
      if (candidatePath !== null && path.startsWith(candidatePath)) {
        await candidate.click()
        expanded = true
        break
      }
    }
    if (!expanded) break
  }
  throw new Error(`Could not reveal repository path ${path}`)
}

test("routes every transcript file gesture to Files and keeps Browser separate", async ({
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
  await expect(window.getByRole("textbox", { name: "docs/spec.md" })).toBeVisible({
    timeout: 15_000
  })
  await expect(window.getByTestId("asset-content-canvas").locator('[data-diffs-header]')).toHaveCount(0)
  await showTree(window)

  // Inline code path → the same Files view.
  await conversationTab(window).click()
  await window.getByTitle("Open out/results.csv").click()
  await expect(window.getByRole("textbox", { name: "out/results.csv" })).toBeVisible({
    timeout: 15_000
  })

  // Relative markdown link → the same Files view.
  await conversationTab(window).click()
  await window.getByRole("button", { name: "the spec" }).click()
  await expect(window.getByRole("textbox", { name: "docs/spec.md" })).toBeVisible({
    timeout: 15_000
  })

  // Untracked files remain navigable; ignored files do not become gestures.
  await conversationTab(window).click()
  await window.getByTitle("Open notes.md").click()
  await expect(window.getByRole("textbox", { name: "notes.md" })).toBeVisible({
    timeout: 15_000
  })
  await conversationTab(window).click()
  await expect(window.getByTitle("Open ignored.md")).toHaveCount(0)

  // The internet browser is a separate session tab, with its own address bar
  // and no file-tab close chrome. Opening it does not replace the file pills.
  await window.getByRole("button", { name: "Browser", exact: true }).click()
  const browser = window.getByLabel("Browser preview")
  await expect(browser.getByLabel("Preview URL")).toBeVisible()
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
  const grammarErrors: string[] = []
  window.on("pageerror", (error) => {
    if (HIGHLIGHTER_LANGUAGE_ERROR.test(error.message)) grammarErrors.push(error.message)
  })

  await expect(appShell(window)).toBeVisible()
  await filesTab(window).click()
  await showTree(window)
  const source = tree(window).locator('[data-item-path="src/edit.ts"]')
  await expect(source).toBeVisible({ timeout: 15_000 })
  await selectTreePath(window, "src/edit.ts")

  let editor = window.getByRole("textbox", { name: "src/edit.ts" })
  await expect(editor).toContainText("export const editable = 42", { timeout: 15_000 })
  await editor.click()
  await editor.press("Meta+a")
  await window.keyboard.insertText("export const editable = 43\n")

  // Switching the session tab unmounts the view, but not its session actor.
  await conversationTab(window).click()
  await filesTab(window).click()
  editor = window.getByRole("textbox", { name: "src/edit.ts" })
  await expect(editor).toContainText("export const editable = 43", { timeout: 15_000 })

  await editor.press("Meta+s")
  await expect.poll(() => readFileSync(join(repoPath, "src", "edit.ts"), "utf8")).toBe(
    "export const editable = 43\n"
  )

  // A later agent write wins on disk. The stale user save becomes a visible,
  // non-destructive conflict and keeps the user's draft while refreshing the
  // revision needed for a deliberate follow-up save.
  editor = window.getByRole("textbox", { name: "src/edit.ts" })
  await editor.click()
  await editor.press("Meta+a")
  await window.keyboard.insertText("export const editable = 44\n")
  writeFileSync(join(repoPath, "src", "edit.ts"), "export const editable = 99\n")

  await editor.press("Meta+s")
  await expect(window.getByText(/Your draft is still here/)).toBeVisible({ timeout: 15_000 })
  await expect(editor).toContainText("export const editable = 44")
  expect(readFileSync(join(repoPath, "src", "edit.ts"), "utf8")).toBe(
    "export const editable = 99\n"
  )

  await window.getByRole("button", { name: "Refresh revision", exact: true }).click()
  editor = window.getByRole("textbox", { name: "src/edit.ts" })
  await expect(editor).toContainText("export const editable = 44", { timeout: 15_000 })
  await expect(window.getByText(/Your draft is still here/)).toHaveCount(0)
  await editor.press("Meta+s")
  await expect.poll(() => readFileSync(join(repoPath, "src", "edit.ts"), "utf8")).toBe(
    "export const editable = 44\n"
  )
  expect(grammarErrors).toEqual([])
})

test("quick-open fills the session with the repository tree and a changed-file diff", async ({
  launchApp
}) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    seed: seedAssets,
    sessions: ({ repoPath }) => [session(repoPath)]
  })

  await expect(appShell(window)).toBeVisible()
  await window.keyboard.press("Meta+Shift+p")
  await window.getByPlaceholder("Open a file in Edit repository files…").fill("main")
  await window.getByTestId("palette-item-file:src/main.ts").click()

  const browser = window.getByTestId("asset-browser")
  await expect(browser).toBeVisible()
  await filesTab(window).click()
  await showTree(window)
  await expect(
    tree(window).filter({ visible: true }).locator('[data-item-path="src/edit.ts"]')
  ).toBeVisible()
  const canvas = window.getByTestId("asset-content-canvas").filter({ visible: true })
  await expect(canvas).toContainText("export const answer = 42", { timeout: 15_000 })
  await expect(canvas).toContainText("export const answer = 43")
  await expect(canvas.locator('[data-diffs-header="default"]')).toHaveCount(0)
  await expect(window.getByRole("button", { name: /Refresh|Reload|Save/ })).toHaveCount(0)

  const dimensions = await browser.evaluate((node) => {
    const rect = node.getBoundingClientRect()
    const parent = node.parentElement?.getBoundingClientRect()
    return { width: rect.width, height: rect.height, parentWidth: parent?.width, parentHeight: parent?.height }
  })
  expect(dimensions.width).toBeGreaterThanOrEqual((dimensions.parentWidth ?? 0) - 2)
  expect(dimensions.height).toBeGreaterThanOrEqual((dimensions.parentHeight ?? 0) - 2)
})

test("keeps the repository tree visible while opening focusing and closing file tabs", async ({
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
  await selectTreePath(window, "src/edit.ts")
  await expect(window.getByTestId("file-tab-src/edit.ts")).toBeVisible({ timeout: 15_000 })
  await expect(window.getByRole("textbox", { name: "src/edit.ts" })).toBeVisible()

  await showTree(window)
  await selectTreePath(window, "docs/spec.md")
  await expect(window.getByTestId("file-tab-docs/spec.md")).toBeVisible({ timeout: 15_000 })
  await expect(window.getByTestId("file-tab-src/edit.ts")).toHaveCount(1)
  await filesTab(window).click()
  await showTree(window)

  await window.getByRole("button", { name: "src/edit.ts", exact: true }).click()
  await expect(window.getByRole("textbox", { name: "src/edit.ts" }).first()).toBeVisible({
    timeout: 15_000
  })
  await expect(window.getByTestId("file-tab-src/edit.ts")).toHaveCount(1)

  await window.getByRole("button", { name: "Close src/edit.ts", exact: true }).click()
  await expect(window.getByTestId("file-tab-src/edit.ts")).toHaveCount(0)
  await expect(window.getByRole("textbox", { name: "docs/spec.md" }).first()).toBeVisible({
    timeout: 15_000
  })
  await filesTab(window).click()
  await showTree(window)
})

test("places the editable file caret where the user clicks", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    seed: seedAssets,
    sessions: ({ repoPath }) => [session(repoPath)]
  })

  await expect(appShell(window)).toBeVisible()
  await filesTab(window).click()
  await window.keyboard.press("Meta+Shift+p")
  await window.getByPlaceholder("Open a file in Edit repository files…").fill("edit.ts")
  await window.getByTestId("palette-item-file:src/edit.ts").click()

  const editor = window.getByRole("textbox", { name: "src/edit.ts" })
  await expect(editor).toBeVisible({ timeout: 15_000 })
  const token = editor.getByText("editable", { exact: true })
  const box = await token.boundingBox()
  if (box === null) throw new Error("editable token has no layout box")
  await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await window.waitForTimeout(800)
  await window.mouse.click(box.x + box.width - 1, box.y + box.height / 2)

  await expect.poll(() => editor.evaluate((element) => {
    const selection = element.getRootNode().getSelection()
    return selection?.focusNode?.textContent === "editable"
      ? selection.focusOffset
      : -1
  })).toBe("editable".length)

  await window.mouse.move(box.x + 1, box.y + box.height / 2)
  await window.mouse.down()
  await window.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 4 })
  await window.mouse.up()
  await expect.poll(() => editor.evaluate((element) =>
    element.getRootNode().getSelection()?.toString()
  )).toBe("editable")
})

test("switches a changed file between diff and edit and saves the edited revision", async ({
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
  await selectTreePath(window, "src/main.ts")

  const edit = window.getByRole("button", { name: "Edit src/main.ts", exact: true })
  const diff = window.getByRole("button", { name: "Show diff for src/main.ts", exact: true })
  await expect(diff).toHaveAttribute("aria-pressed", "true", { timeout: 15_000 })
  await expect(window.getByTestId("asset-content-canvas")).toContainText(
    "export const answer = 43"
  )

  await edit.click()
  const editor = window.getByRole("textbox", { name: "src/main.ts" })
  await expect(editor).toContainText("export const answer = 43", { timeout: 15_000 })
  await editor.click()
  await editor.press("Meta+a")
  await window.keyboard.insertText("export const answer = 44\n")
  await editor.press("Meta+s")
  await expect.poll(() => readFileSync(join(repoPath, "src", "main.ts"), "utf8")).toBe(
    "export const answer = 44\n"
  )

  // Back on the diff, the SAVED revision is what differs from HEAD — not the
  // pre-save buffer the diff first opened on.
  await diff.click()
  await expect(diff).toHaveAttribute("aria-pressed", "true")
  const canvas = window.getByTestId("asset-content-canvas")
  await expect(canvas).toContainText("export const answer = 44")
  await expect(canvas).not.toContainText("export const answer = 43")
})

test("forwards selected current-buffer lines to the active chat with Cmd-J", async ({
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
  await selectTreePath(window, "src/edit.ts")
  const editor = window.getByRole("textbox", { name: "src/edit.ts" })
  await expect(editor).toBeVisible({ timeout: 15_000 })
  await editor.click()
  await editor.press("Meta+a")
  await window.keyboard.insertText(
    "export const selected = 1\nexport const unsaved = 2\nexport const ignored = 3\n"
  )

  const lines = window.locator("diffs-container [data-column-number]").filter({ visible: true })
  await expect(lines.first()).toBeVisible()
  const selectLine = async (line: Locator, shiftKey = false) => {
    const box = await line.boundingBox()
    expect(box).not.toBeNull()
    const clientX = box!.x + 6
    const clientY = box!.y + 6
    await line.dispatchEvent("pointerdown", {
      pointerId: 1, pointerType: "mouse", button: 0, clientX, clientY, shiftKey
    })
    await window.locator("body").dispatchEvent("pointerup", {
      pointerId: 1, pointerType: "mouse", button: 0, clientX, clientY, shiftKey
    })
  }
  await selectLine(lines.first())
  await selectLine(lines.nth(1), true)
  await editor.focus()
  await window.keyboard.press("Meta+j")

  await expect(window.getByTestId("conversation-scroll")).toBeVisible()
  await expect(
    window.getByRole("button", { name: "Remove src/edit.ts:L1–L2", exact: true })
  ).toBeVisible()
  await expect(window.getByPlaceholder("Message the agent…")).toBeFocused()
})

test("loads a real large repository tree without leaving Files blank", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    seed: ({ repoPath }) => {
      for (let directory = 0; directory < 56; directory += 1) {
        const root = join(repoPath, "packages", `group-${directory}`)
        mkdirSync(root, { recursive: true })
        for (let file = 0; file < 100; file += 1) {
          writeFileSync(join(root, `file-${file}.ts`), `export const value = ${file}\n`)
        }
      }
    },
    sessions: ({ repoPath }) => [session(repoPath)]
  })

  await expect(appShell(window)).toBeVisible()
  await filesTab(window).click()
  await showTree(window)
  await expect(
    tree(window).getByRole("treeitem", { name: "packages", exact: true })
  ).toBeVisible({ timeout: 15_000 })
  await expect(window.getByText("Loading files…")).toHaveCount(0)
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
  await selectTreePath(window, "README.custom")
  await expect(window.getByRole("textbox", { name: "README.custom" })).toContainText(
    "extension-free text is editable",
    { timeout: 15_000 }
  )

  await showTree(window)
  await selectTreePath(window, "archive.bin")
  await expect(window.getByText("Binary file", { exact: true })).toBeVisible({ timeout: 15_000 })
  await expect(window.getByRole("button", { name: "Save", exact: true })).toHaveCount(0)
})
