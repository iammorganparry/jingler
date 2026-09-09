import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import type { Page } from "@playwright/test"
import { appShell, expect, sessionRow, test } from "./fixtures.js"
import type { SeedSession } from "./fixtures.js"

const session = (worktreePath: string): SeedSession => ({
  id: "s_file_browser_ide",
  repo: "widget",
  branch: "jingler/file-browser-ide",
  title: "File browser IDE",
  status: "idle",
  diff: { added: 0, removed: 0 },
  prNumber: null,
  costUsd: 0,
  tokens: 0,
  updatedAt: "2026-08-08T00:00:00.000Z",
  worktreePath,
  mode: "auto",
})

const otherSession = (worktreePath: string): SeedSession => ({
  ...session(worktreePath),
  id: "s_file_browser_other",
  branch: "jingler/file-browser-other",
  title: "Other file browser session",
  updatedAt: "2026-08-07T00:00:00.000Z"
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

const filesTab = (window: Page) => window.getByTestId("view-tab-files")

const projectRoot = resolve(import.meta.dirname, "../../..")

const showRepositoryTree = async (window: Page) => {
  const tree = window.locator(
    '[data-jingler-pierre-file-tree][aria-label="Repository files"]'
  ).filter({ visible: true }).first()
  if ((await tree.count()) === 0) {
    await window.getByRole("button", { name: "Repository files", exact: true })
      .filter({ visible: true }).last().click()
  }
  await expect(tree).toBeVisible()
  return tree
}

const selectTreePath = async (window: Page, path: string): Promise<void> => {
  const tree = await showRepositoryTree(window)
  const target = tree.locator(`[role="treeitem"][data-item-path="${path}"]`)
  const segments = path.split("/")
  const ancestorPaths = segments
    .slice(0, -1)
    .map((_, index) => segments.slice(0, index + 1).join("/"))
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if ((await target.count()) > 0 && (await target.isVisible())) {
      await selectVisibleTreeItem(target)
      return
    }
    let expandedAncestor = await expandTreeAncestor(ancestorPaths, tree)
    if (expandedAncestor) continue
    let collapsedUnrelated = await collapseUnrelatedTreeFolder(tree, path)
    if (collapsedUnrelated) continue
    let expanded = await expandMatchingTreeFolder(tree, path)
    if (!expanded) {
      const advanced = await tree.evaluate((node) => {
        const ancestors: HTMLElement[] = []
        let ancestor = node.parentElement
        while (ancestor !== null) {
          ancestors.push(ancestor)
          ancestor = ancestor.parentElement
        }
        const elements = [node, ...node.querySelectorAll<HTMLElement>("*"), ...ancestors]
        const scroller = elements.find((element) => {
          const style = getComputedStyle(element)
          return (
            element.scrollHeight > element.clientHeight + 1 &&
            (style.overflowY === "auto" || style.overflowY === "scroll")
          )
        })
        if (scroller === undefined) return false
        const previous = scroller.scrollTop
        scroller.scrollTop = Math.min(
          scroller.scrollHeight - scroller.clientHeight,
          previous + Math.max(1, Math.floor(scroller.clientHeight * 0.8))
        )
        scroller.dispatchEvent(new Event("scroll", { bubbles: true }))
        return scroller.scrollTop > previous
      })
      if (!advanced) break
      await window.waitForTimeout(25)
    }
  }
  const mountedPaths = await tree.locator('[role="treeitem"]').evaluateAll((items) =>
    items.map((item) => ({
      expanded: item.getAttribute("aria-expanded"),
      path: item.getAttribute("data-item-path")
    }))
  )
  throw new Error(
    `Could not reveal repository path ${path}; mounted=${JSON.stringify(mountedPaths)}`
  )
}

const splitChatBesideFiles = async (window: Page): Promise<void> => {
  await window.evaluate(() => {
    const source = document.querySelector('[data-testid^="chat-tab-"]')
    const target = document.querySelector('[data-testid="surface-pane-0"]')
    if (!source || !target) throw new Error("missing chat/file split node")
    const box = target.getBoundingClientRect()
    const dataTransfer = new DataTransfer()
    const init = {
      dataTransfer,
      bubbles: true,
      cancelable: true,
      clientX: box.left + box.width * 0.04,
      clientY: box.top + box.height / 2
    }
    source.dispatchEvent(new DragEvent("dragstart", init))
    target.dispatchEvent(new DragEvent("dragover", init))
    target.dispatchEvent(new DragEvent("drop", init))
    source.dispatchEvent(new DragEvent("dragend", init))
  })
  await expect(window.getByTestId("surface-view")).toHaveAttribute("data-panes", "2")
}

const selectFirstTwoLines = async (window: Page): Promise<void> => {
  const lineNumbers = window.locator("diffs-container [data-column-number]")
  await expect(lineNumbers.first()).toBeVisible()
  await lineNumbers.first().click({ position: { x: 6, y: 6 } })
  await lineNumbers.nth(1).click({ modifiers: ["Shift"], position: { x: 6, y: 6 } })
  await expect(lineNumbers.first()).toHaveAttribute("data-selected-line")
  await expect(lineNumbers.nth(1)).toHaveAttribute("data-selected-line")
}

test("splits the session repository beside chat and edits a file through Pierre", async ({
  launchApp
}) => {
  const { window, repoPath } = await launchApp({
    configured: true,
    isolateSystemHome: true,
    withRepo: true,
    seed: seedRepository,
    sessions: ({ repoPath }) => [session(repoPath)]
  })

  await expect(appShell(window)).toBeVisible()
  await filesTab(window).click()
  await showRepositoryTree(window)
  await splitChatBesideFiles(window)
  await expect(window.getByTestId("surface-pane-0")).toBeVisible()
  await expect(window.getByTestId("surface-pane-1")).toBeVisible()

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
  const edit = window.getByRole("button", { name: "Edit src/config.ts" })
  if ((await edit.count()) > 0) await edit.click()
  await expect(
    window.locator('[data-surface*="src/config.ts"]').getByRole("textbox", { name: "src/config.ts" })
  ).toContainText("export const mode = 'modern'")
})

test("shows a previously existing large worktree without a repository search bar", async ({
  launchApp
}) => {
  const { window } = await launchApp({
    configured: true,
    isolateSystemHome: true,
    sessions: [session(projectRoot)]
  })

  await expect(appShell(window)).toBeVisible()
  await window.setViewportSize({ width: 1320, height: 860 })
  await filesTab(window).click()
  const tree = await showRepositoryTree(window)
  await expect.poll(async () => (await tree.boundingBox())?.height ?? 0).toBeGreaterThan(400)
  await expect(tree.locator('[role="treeitem"]').first()).toBeVisible({
    timeout: 20_000
  })
  await expect(tree.locator('[data-file-tree-search-input]')).toHaveCount(0)

  await window.keyboard.press("Meta+Shift+p")
  await window.getByPlaceholder("Open a file in File browser IDE…")
    .fill("generate-brand-icons")
  await window.getByTestId("palette-item-file:scripts/generate-brand-icons.py").click()
  const editor = window.getByRole("region", {
    name: "scripts/generate-brand-icons.py editor"
  })
  await expect(editor).toBeVisible()
  const editorSurface = editor.locator(".jingler-pierre-code-view")
  await expect.poll(async () => editorSurface.evaluate((node) => {
    return getComputedStyle(node).backgroundColor
  })).not.toBe("rgba(0, 0, 0, 0)")
  await expect.poll(async () => {
    const editorBox = await editor.boundingBox()
    const canvasBox = await window.getByTestId("asset-content-canvas").boundingBox()
    return Math.abs((editorBox?.height ?? 0) - (canvasBox?.height ?? 0))
  }).toBeLessThan(1)

  await editorSurface.evaluate((node) => {
    node.scrollTop = node.scrollHeight
    node.dispatchEvent(new Event("scroll", { bubbles: true }))
  })
  const finalLine = editorSurface.locator('[data-column-number="146"]')
  await expect(finalLine).toBeVisible()
  await expect.poll(async () => {
    const editorBox = await editorSurface.boundingBox()
    const lineBox = await finalLine.boundingBox()
    if (editorBox === null || lineBox === null) return Number.NEGATIVE_INFINITY
    return editorBox.y + editorBox.height - (lineBox.y + lineBox.height)
  }).toBeGreaterThanOrEqual(24)

  // This is the real repository file that exposed the clipped final line in
  // the wide Files pane. Keep it explicit so a virtual-scroll-only fixture
  // cannot mask the editor's actual bottom boundary.
  await selectTreePath(window, "packages/plugin-sdk/src/ui.ts")
  const uiEditor = window.getByRole("region", {
    name: "packages/plugin-sdk/src/ui.ts editor"
  })
  const uiEditorSurface = uiEditor.locator(".jingler-pierre-code-view")
  const uiEditorFooter = uiEditorSurface.locator(
    "[data-jingler-pierre-code-view-footer]"
  )
  await expect(uiEditorFooter).toBeVisible()
  await expect.poll(async () => (await uiEditorFooter.boundingBox())?.height ?? 0)
    .toBeGreaterThanOrEqual(64)
  await uiEditorSurface.evaluate((node) => {
    node.scrollTop = node.scrollHeight
    node.dispatchEvent(new Event("scroll", { bubbles: true }))
  })
  const uiFinalLine = uiEditorSurface.locator('[data-column-number="84"]')
  await expect(uiFinalLine).toBeVisible()
  await expect.poll(async () => {
    const editorBox = await uiEditorSurface.boundingBox()
    const lineBox = await uiFinalLine.boundingBox()
    if (editorBox === null || lineBox === null) return Number.NEGATIVE_INFINITY
    return editorBox.y + editorBox.height - (lineBox.y + lineBox.height)
  }).toBeGreaterThanOrEqual(24)

  await window.getByRole("button", { name: "Chat 1", exact: true }).click()
  await filesTab(window).click()
  const restoredTree = await showRepositoryTree(window)
  await expect(restoredTree.locator('[role="treeitem"]').first()).toBeVisible({
    timeout: 20_000
  })
})

test("shows a previously existing large worktree while its agent is running", async ({
  launchApp
}) => {
  const { window } = await launchApp({
    configured: true,
    isolateSystemHome: true,
    sessions: [session(projectRoot)]
  })

  await expect(appShell(window)).toBeVisible()
  const composer = window.getByPlaceholder("Message the agent…")
  await composer.fill("[[queue-hold]] keep this existing session busy")
  await composer.press("Enter")
  await expect(window.getByText("Holding the active turn for queue actions.")).toBeVisible({
    timeout: 15_000
  })
  await filesTab(window).click()
  const tree = await showRepositoryTree(window)
  await expect(tree.locator('[role="treeitem"]').first()).toBeVisible({
    timeout: 20_000
  })
})

test("adds selected code to the active chat from the editor context menu", async ({
  launchApp
}) => {
  const { window } = await launchApp({
    configured: true,
    isolateSystemHome: true,
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
  await expect(window.getByPlaceholder("Message the agent…")).toBeFocused()
})

test("adds selected code to the active chat with the platform J shortcut", async ({
  launchApp
}) => {
  const { window } = await launchApp({
    configured: true,
    isolateSystemHome: true,
    withRepo: true,
    seed: seedRepository,
    sessions: ({ repoPath }) => [session(repoPath)]
  })

  await expect(appShell(window)).toBeVisible()
  await filesTab(window).click()
  await selectTreePath(window, "src/config.ts")
  await selectFirstTwoLines(window)
  await window.getByRole("textbox", { name: "src/config.ts" }).focus()
  await window.keyboard.press("ControlOrMeta+j")

  await expect(
    window.getByRole("button", { name: "Remove src/config.ts:L1–L2", exact: true })
  ).toBeVisible()
})

test("follows the selected chat agent through edited and newly created files", async ({
  launchApp
}) => {
  const { window } = await launchApp({
    configured: true,
    isolateSystemHome: true,
    withRepo: true,
    seed: seedRepository,
    sessions: ({ repoPath }) => [session(repoPath), otherSession(repoPath)]
  })

  await expect(appShell(window)).toBeVisible()
  await sessionRow(window, "File browser IDE").click()
  const composerFollow = window
    .getByTestId("composer")
    .getByRole("button", { name: "Follow agent", exact: true })
  await composerFollow.click()
  await splitChatBesideFiles(window)
  await expect(window.getByTestId("surface-view")).toHaveAttribute("data-panes", "2")
  await expect(composerFollow).toHaveAttribute("aria-pressed", "true")
  await expect(composerFollow).toHaveClass(/is-active/)
  await expect(composerFollow.locator("svg")).toHaveClass(/lucide-mouse-pointer-2/)
  const workspaceFollow = window
    .getByTestId("asset-browser")
    .getByRole("button", { name: "Follow agent", exact: true })
  await expect(workspaceFollow).toHaveAttribute("aria-pressed", "true")
  await expect(workspaceFollow).toHaveClass(/is-active/)
  await expect(workspaceFollow.locator("svg")).toHaveClass(/lucide-mouse-pointer-2/)

  await sessionRow(window, "Other file browser session").click()
  await expect(window.getByText("Other file browser session", { exact: true }).last()).toBeVisible()
  await sessionRow(window, "File browser IDE").click()
  await expect(window.getByTestId("surface-view")).toHaveAttribute("data-panes", "2")
  await expect(composerFollow).toHaveAttribute("aria-pressed", "true")

  // Prove the initial repository scan has settled before pi creates the file.
  const initialTree = await showRepositoryTree(window)
  await expect(initialTree.locator('[role="treeitem"]').first()).toBeVisible()
  const composer = window.getByPlaceholder("Message the agent…")
  await composer.fill("[[codex-edit-preview]] Update and create the configuration files.")
  await composer.press("Enter")

  await expect(
    window
      .getByTestId("file-tab-src/config.ts")
      .getByRole("button", { name: "src/config.ts", exact: true })
  ).toBeVisible({ timeout: 20_000 })
  await expect(window.getByRole("region", { name: "src/created.ts changes" })).toBeVisible({
    timeout: 20_000
  })
  await expect(
    window
      .getByTestId("file-tab-src/created.ts")
      .getByRole("button", { name: "src/created.ts", exact: true })
  ).toBeVisible()

  await selectTreePath(window, "src/other.ts")
  await expect(composerFollow).toHaveAttribute("aria-pressed", "false")
})

test("follows a nested sub-agent edit for the selected chat", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    isolateSystemHome: true,
    withRepo: true,
    seed: seedRepository,
    sessions: ({ repoPath }) => [session(repoPath)]
  })

  await expect(appShell(window)).toBeVisible()
  const composerFollow = window
    .getByTestId("composer")
    .getByRole("button", { name: "Follow agent", exact: true })
  await composerFollow.click()
  await splitChatBesideFiles(window)

  const composer = window.getByPlaceholder("Message the agent…")
  await composer.fill("[[subagent-edit-preview]] Delegate this file update.")
  await composer.press("Enter")

  await expect(
    window.getByRole("region", { name: "src/delegated.ts changes" })
  ).toBeVisible({ timeout: 20_000 })
  await expect(
    window
      .getByTestId("file-tab-src/delegated.ts")
      .getByRole("button", { name: "src/delegated.ts", exact: true })
  ).toBeVisible()
  await expect(composerFollow).toHaveAttribute("aria-pressed", "true")
})

test("refreshes the repository tree and follows a moved file to its destination", async ({
  launchApp
}) => {
  const { window } = await launchApp({
    configured: true,
    isolateSystemHome: true,
    withRepo: true,
    seed: seedRepository,
    sessions: ({ repoPath }) => [session(repoPath)]
  })

  await expect(appShell(window)).toBeVisible()
  const composerFollow = window
    .getByTestId("composer")
    .getByRole("button", { name: "Follow agent", exact: true })
  await composerFollow.click()
  await splitChatBesideFiles(window)
  await selectTreePath(window, "src/config.ts")
  await composerFollow.click()
  await expect(composerFollow).toHaveAttribute("aria-pressed", "true")

  const composer = window.getByPlaceholder("Message the agent…")
  await composer.fill("[[follow-file-move]] Move and update the configuration file.")
  await composer.press("Enter")

  await expect(
    window
      .getByTestId("file-tab-src/settings/config.ts")
      .getByRole("button", { name: "src/settings/config.ts", exact: true })
  ).toBeVisible({ timeout: 20_000 })
  const movedDiff = window.getByRole("region", {
    name: "src/settings/config.ts changes"
  })
  await expect(movedDiff).toBeVisible()
  await expect(
    movedDiff.getByText("export const mode = 'modern'", { exact: true })
  ).toBeVisible()

  const tree = window.locator(
    '[data-jingler-pierre-file-tree][aria-label="Repository files"]'
  )
  await expect(tree.locator('[data-item-path="src/config.ts"]')).toHaveCount(0)
  await expect(tree.locator('[data-item-path="src/settings/"]')).toHaveCount(1)
  await expect(composerFollow).toHaveAttribute("aria-pressed", "true")
})

test("reveals the followed mutation diff and sends selected feedback with context", async ({
  launchApp
}) => {
  const { window } = await launchApp({
    configured: true,
    isolateSystemHome: true,
    withRepo: true,
    seed: seedRepository,
    sessions: ({ repoPath }) => [session(repoPath), otherSession(repoPath)]
  })

  await expect(appShell(window)).toBeVisible()
  const composerFollow = window
    .getByTestId("composer")
    .getByRole("button", { name: "Follow agent", exact: true })
  await composerFollow.click()
  await splitChatBesideFiles(window)
  const composer = window.getByPlaceholder("Message the agent…")
  await composer.fill("[[follow-diff-preview]] Update the configuration mode.")
  await composer.press("Enter")

  const followed = window.locator('[data-follow-agent-change="follow-diff-1"]')
  await expect(followed).toBeVisible({ timeout: 20_000 })
  await expect(window.getByRole("region", { name: "src/config.ts changes" })).toBeVisible()
  await expect(followed.getByText("export const mode = 'modern'", { exact: true })).toBeVisible()
  await expect(followed.locator("[data-jingler-pierre-code-view-footer]")).toBeAttached()

  await expect(followed.getByRole("button", { name: "Add to chat" })).toHaveCount(0)
  await expect(followed.getByPlaceholder("Ask the agent to fix this…")).toHaveCount(0)

  const followedLine = followed
    .locator('[data-line-type="change-addition"][data-column-number="1"]')
    .first()
  await expect(followedLine).toBeVisible()
  await expect(followedLine).not.toHaveAttribute("data-selected-line")
  const followedLineColors = await followedLine.evaluate((element) => {
    const root = element.getRootNode()
    if (!(root instanceof ShadowRoot)) throw new Error("Pierre diff shadow root is missing")
    const resolveBackground = (value: string): string => {
      const probe = document.createElement("span")
      probe.style.backgroundColor = value
      root.append(probe)
      const resolved = getComputedStyle(probe).backgroundColor
      probe.remove()
      return resolved
    }
    const hostStyle = getComputedStyle(root.host)
    return {
      actual: getComputedStyle(element).backgroundColor,
      addition: resolveBackground(hostStyle.getPropertyValue("--sb-diff-add-bg")),
      deletion: resolveBackground(hostStyle.getPropertyValue("--sb-diff-del-bg")),
      selection: resolveBackground(hostStyle.getPropertyValue("--sb-selection"))
    }
  })
  expect(followedLineColors.actual).toBe(followedLineColors.addition)
  expect(followedLineColors.actual).not.toBe(followedLineColors.deletion)
  expect(followedLineColors.actual).not.toBe(followedLineColors.selection)
  await followedLine.click({ position: { x: 6, y: 6 } })

  const addToChat = followed.getByRole("button", { name: "Add to chat" })
  await expect(addToChat).toBeVisible()
  await addToChat.click()
  await expect(
    window.getByRole("button", { name: "Remove src/config.ts:L1", exact: true })
  ).toBeVisible()

  await filesTab(window).click()
  await expect(followed).toBeVisible()
  await followedLine.click({ position: { x: 6, y: 6 } })
  const comment = followed.getByPlaceholder("Ask the agent to fix this…")
  await comment.fill("[[expect-code-context]] Keep the new mode but document it.")
  await followed.getByRole("button", { name: "Send to agent" }).click()

  await sessionRow(window, "Other file browser session").click()
  await sessionRow(window, "File browser IDE").click()
  await expect(filesTab(window)).toHaveAttribute("aria-current", "page")
  await expect(followed).toBeVisible()
  await expect(window.getByText("Received selected diff context.", { exact: true })).toBeVisible({
    timeout: 20_000
  })
})

async function selectVisibleTreeItem(target: import("@playwright/test").Locator) {
  await target.click()
}

async function expandTreeAncestor(ancestorPaths: string[], tree: import("@playwright/test").Locator) {
  let expandedAncestor = false
  for (const ancestorPath of ancestorPaths) {
    const ancestor = tree.locator(
      `[role="treeitem"][data-item-path="${ancestorPath}/"]`
    )
    if ((await ancestor.count()) > 0 &&
      (await ancestor.isVisible()) &&
      (await ancestor.getAttribute("aria-expanded")) !== "true") {
      await ancestor.focus()
      await ancestor.press("ArrowRight")
      expandedAncestor = true
      break
    }
  }
  return expandedAncestor
}

async function collapseUnrelatedTreeFolder(tree: import("@playwright/test").Locator, path: string) {
  const unrelatedExpanded = tree.locator('[role="treeitem"][aria-expanded="true"]')
  const expandedCount = await unrelatedExpanded.count()
  let collapsedUnrelated = false
  for (let index = 0; index < expandedCount; index += 1) {
    const candidate = unrelatedExpanded.nth(index)
    const candidatePath = await candidate.getAttribute("data-item-path")
    if (candidatePath !== null && !path.startsWith(candidatePath)) {
      await candidate.click()
      collapsedUnrelated = true
      break
    }
  }
  return collapsedUnrelated
}

async function expandMatchingTreeFolder(tree: import("@playwright/test").Locator, path: string) {
  const collapsed = tree.locator('[role="treeitem"][aria-expanded="false"]')
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
  return expanded
}
