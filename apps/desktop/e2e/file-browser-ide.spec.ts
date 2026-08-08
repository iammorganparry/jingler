import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Page } from "@playwright/test"
import { appShell, expect, test } from "./fixtures.js"
import type { SeedSession } from "./fixtures.js"

const session = (worktreePath: string): SeedSession => ({
  id: "s_file_browser_ide",
  repo: "widget",
  branch: "jingler/file-browser-ide",
  title: "File browser IDE",
  status: "idle",
  cli: "codex",
  diff: { added: 0, removed: 0 },
  prNumber: null,
  costUsd: 0,
  tokens: 0,
  updatedAt: "2026-08-08T00:00:00.000Z",
  worktreePath,
  mode: "auto",
  model: "gpt-5.6-sol"
})

const seedRepository = ({ repoPath }: { repoPath: string }): void => {
  mkdirSync(join(repoPath, "src"), { recursive: true })
  writeFileSync(
    join(repoPath, "src", "config.ts"),
    [
      "export const mode = 'legacy'",
      "export const retries = 2",
      "export const timeout = 1_000"
    ].join("\n") + "\n"
  )
  writeFileSync(join(repoPath, "src", "other.ts"), "export const other = true\n")
  execFileSync("git", ["add", "-A"], { cwd: repoPath })
  execFileSync("git", ["commit", "-m", "seed file browser IDE", "--no-gpg-sign"], {
    cwd: repoPath
  })
}

const filesTab = (window: Page) =>
  window.getByRole("button", { name: "Files", exact: true })

const selectTreePath = async (window: Page, path: string): Promise<void> => {
  const tree = window.locator(
    '[data-jingler-pierre-file-tree][aria-label="Repository files"]'
  )
  const toggle = window.getByRole("button", { name: "Repository files", exact: true })
  if ((await toggle.count()) > 0 && (await toggle.getAttribute("aria-expanded")) !== "true") {
    await toggle.click()
  }
  await expect(tree).toBeVisible()
  const search = tree.locator("[data-file-tree-search-input]")
  await search.fill(path)
  await search.press("Enter")
}

const selectFirstTwoLines = async (window: Page): Promise<void> => {
  const lineNumbers = window.locator("diffs-container [data-column-number]")
  await expect(lineNumbers.first()).toBeVisible()
  await lineNumbers.first().click({ position: { x: 6, y: 6 } })
  await lineNumbers.nth(1).click({ modifiers: ["Shift"], position: { x: 6, y: 6 } })
}

test("opens the session repository beside chat and edits a file through Pierre", async ({
  launchApp
}) => {
  const { window, repoPath } = await launchApp({
    configured: true,
    withRepo: true,
    seed: seedRepository,
    sessions: ({ repoPath }) => [session(repoPath)]
  })

  await expect(appShell(window)).toBeVisible()
  await filesTab(window).click()
  const split = window.getByTestId("session-auxiliary-split")
  const chat = window.getByTestId("session-auxiliary-chat")
  await expect(split).toBeVisible()
  await expect
    .poll(async () => {
      const splitBox = await split.boundingBox()
      const chatBox = await chat.boundingBox()
      if (splitBox === null || chatBox === null) return 0
      return chatBox.width / splitBox.width
    })
    .toBeGreaterThan(0.28)
  expect(
    await (async () => {
      const splitBox = await split.boundingBox()
      const chatBox = await chat.boundingBox()
      if (splitBox === null || chatBox === null) return 1
      return chatBox.width / splitBox.width
    })()
  ).toBeLessThan(0.39)

  await selectTreePath(window, "src/config.ts")
  const editor = window.getByRole("textbox", { name: "src/config.ts" })
  await expect(editor).toContainText("export const mode = 'legacy'", { timeout: 15_000 })
  await expect(
    window
      .getByTestId("file-tab-src/config.ts")
      .getByRole("button", { name: "src/config.ts", exact: true })
  ).toHaveAttribute(
    "aria-current",
    "page"
  )

  const themeBridge = await window
    .getByRole("region", { name: "src/config.ts editor" })
    .locator("diffs-container")
    .evaluate((element) => {
      const root = element.shadowRoot
      const code = root?.querySelector<HTMLElement>("code")
      if (code === undefined || code === null) throw new Error("Pierre code surface did not render")
      const probe = document.createElement("div")
      probe.style.backgroundColor = "var(--sb-editor)"
      document.body.append(probe)
      const expected = getComputedStyle(probe).backgroundColor
      const actualProbe = document.createElement("div")
      actualProbe.style.backgroundColor = getComputedStyle(element)
        .getPropertyValue("--diffs-bg-context-override")
        .trim()
      document.body.append(actualProbe)
      const actual = getComputedStyle(actualProbe).backgroundColor
      probe.remove()
      actualProbe.remove()
      return { expected, actual }
    })
  expect(themeBridge.actual).toBe(themeBridge.expected)

  await editor.click()
  await editor.press("Meta+a")
  await window.keyboard.insertText("export const mode = 'modern'\n")
  await editor.press("Meta+s")
  await expect.poll(() => readFileSync(join(repoPath, "src", "config.ts"), "utf8")).toBe(
    "export const mode = 'modern'\n"
  )

  await selectTreePath(window, "src/other.ts")
  await window.getByTestId("file-tab-src/config.ts").click()
  // Modified files reopen diff-first; switching back to Edit must hydrate the
  // saved draft rather than the pre-save disk payload.
  await window.getByRole("button", { name: "Edit src/config.ts" }).click()
  await expect(window.getByRole("textbox", { name: "src/config.ts" })).toContainText(
    "export const mode = 'modern'"
  )
})

test("adds selected code to the active chat from the editor context menu", async ({
  launchApp
}) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    seed: seedRepository,
    sessions: ({ repoPath }) => [session(repoPath)]
  })

  await expect(appShell(window)).toBeVisible()
  await filesTab(window).click()
  await selectTreePath(window, "src/config.ts")
  await selectFirstTwoLines(window)
  await window
    .getByRole("region", { name: "src/config.ts editor" })
    .click({ button: "right", position: { x: 260, y: 60 } })
  await window.getByRole("menuitem", { name: "Add selection to chat" }).click()

  await expect(
    window.getByRole("button", { name: "Remove src/config.ts:L1–L2", exact: true })
  ).toBeVisible()
  await expect(window.getByPlaceholder("Message Codex…")).toBeFocused()
})

test("adds selected code to the active chat with the platform J shortcut", async ({
  launchApp
}) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    seed: seedRepository,
    sessions: ({ repoPath }) => [session(repoPath)]
  })

  await expect(appShell(window)).toBeVisible()
  await filesTab(window).click()
  await selectTreePath(window, "src/config.ts")
  await selectFirstTwoLines(window)
  await window.keyboard.press("Meta+j")

  await expect(
    window.getByRole("button", { name: "Remove src/config.ts:L1–L2", exact: true })
  ).toBeVisible()
})

test("follows the selected chat agent through edited and newly created files", async ({
  launchApp
}) => {
  const { window, repoPath } = await launchApp({
    configured: true,
    withRepo: true,
    seed: seedRepository,
    sessions: ({ repoPath }) => [session(repoPath)]
  })

  await expect(appShell(window)).toBeVisible()
  const composerFollow = window
    .getByTestId("composer")
    .getByRole("button", { name: "Follow agent", exact: true })
  await composerFollow.click()
  await expect(window.getByTestId("session-auxiliary-split")).toBeVisible()
  await expect(filesTab(window)).toHaveAttribute("aria-current", "page")
  await expect(composerFollow).toHaveAttribute("aria-pressed", "true")

  const composer = window.getByPlaceholder("Message Codex…")
  await composer.fill("[[codex-edit-preview]] Update and create the configuration files.")
  await composer.press("Enter")

  await expect(window.getByRole("textbox", { name: "src/config.ts" })).toBeVisible({
    timeout: 20_000
  })
  writeFileSync(join(repoPath, "src", "created.ts"), "export const created = true\n")
  await expect(window.getByRole("textbox", { name: "src/created.ts" })).toBeVisible({
    timeout: 20_000
  })
  await expect(
    window
      .getByTestId("file-tab-src/created.ts")
      .getByRole("button", { name: "src/created.ts", exact: true })
  ).toHaveAttribute(
    "aria-current",
    "page"
  )

  await selectTreePath(window, "src/other.ts")
  await expect(composerFollow).toHaveAttribute("aria-pressed", "false")
})
