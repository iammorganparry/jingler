import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Locator, Page } from "@playwright/test"
import { appShell, expect, test } from "./fixtures.js"
import type { SeedSession } from "./fixtures.js"

/**
 * Opening a file adds a pane beside the files already open. Those panes must
 * not repaint: Pierre force-renders its whole shadow DOM whenever an option it
 * is handed changes identity, and a re-created callback is enough to blank and
 * redraw a file the operator was not touching — a visible flash per click.
 */

const session = (worktreePath: string): SeedSession => ({
  id: "s_file_pane_stability",
  repo: "widget",
  branch: "jingler/file-pane-stability",
  title: "File pane stability",
  status: "idle",
  diff: { added: 0, removed: 0 },
  prNumber: null,
  costUsd: 0,
  tokens: 0,
  updatedAt: "2026-08-08T00:00:00.000Z",
  worktreePath,
  mode: "auto"
})

const seedRepository = ({ repoPath }: { repoPath: string }): void => {
  mkdirSync(join(repoPath, "src"), { recursive: true })
  for (const name of ["alpha", "beta", "gamma"]) {
    writeFileSync(
      join(repoPath, "src", `${name}.ts`),
      `${Array.from({ length: 40 }, (_, i) => `export const ${name}${i} = ${i}`).join("\n")}\n`
    )
  }
  execFileSync("git", ["add", "-A"], { cwd: repoPath })
  execFileSync("git", ["commit", "-m", "seed", "--no-gpg-sign"], { cwd: repoPath })
}

const openFile = async (window: Page, path: string): Promise<void> => {
  await window.getByRole("tab", { name: "Explorer" }).click()
  const tree = window.locator('[data-jingler-pierre-file-tree][aria-label="Repository files"]')
    .filter({ visible: true }).first()
  await expect(tree).toBeVisible()
  const folder = tree.locator('[role="treeitem"][data-item-path="src"]')
  const item = tree.locator(`[role="treeitem"][data-item-path="${path}"]`)
  if (!(await item.isVisible())) await folder.click()
  await item.click()
  await expect(window.getByRole("textbox", { name: path })).toContainText(
    "export const",
    { timeout: 15_000 }
  )
}

const filePane = (window: Page, path: string) =>
  window.locator(`[data-surface*='${JSON.stringify(path)}']`)

/** Watch a pane's rendered code for any DOM churn from here on. */
const watchPane = (pane: Locator, key: string) =>
  pane.locator("diffs-container").evaluate((host, key) => {
    const root = host.shadowRoot
    const code = root?.querySelector("code")
    if (!root || !code) throw new Error("Pierre code surface did not render")
    const scope = window as unknown as { __panes?: Record<string, { mutations: number; code: Element }> }
    const probe = { mutations: 0, code }
    scope.__panes = { ...scope.__panes, [key]: probe }
    new MutationObserver((records) => {
      probe.mutations += records.length
    }).observe(root, { childList: true, subtree: true, characterData: true })
  }, key)

const paneChurn = (pane: Locator, key: string) =>
  pane.locator("diffs-container").evaluate((host, key) => {
    const probe = (window as unknown as { __panes: Record<string, { mutations: number; code: Element }> })
      .__panes[key]!
    return {
      mutations: probe.mutations,
      sameCode: host.shadowRoot?.querySelector("code") === probe.code
    }
  }, key)

const openTab = async (window: Page, path: string): Promise<void> => {
  await window.getByTestId(`file-tab-${path}`).getByRole("button", { name: path, exact: true }).click()
  await expect(filePane(window, path).getByRole("textbox", { name: path })).toContainText(
    "export const",
    { timeout: 15_000 }
  )
}

test("opening another file leaves the files already open untouched", async ({ launchApp }) => {
  const { app, window } = await launchApp({
    configured: true,
    isolateSystemHome: true,
    withRepo: true,
    seed: seedRepository,
    sessions: ({ repoPath }) => [session(repoPath)]
  })

  // Wide enough for chat plus two file panes side by side.
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(1800, 1000)
  })
  await expect(appShell(window)).toBeVisible()
  await openFile(window, "src/alpha.ts")
  await openFile(window, "src/beta.ts")

  // Free the chat's slot so the two files can sit side by side (MAX_PANES = 3).
  await window.getByRole("button", { name: "Close pane 1" }).click()
  await openTab(window, "src/alpha.ts")
  await expect(window.getByTestId("surface-view")).toHaveAttribute("data-panes", "2")
  const filesView = window.locator(`[data-surface='${JSON.stringify(["view", "files", null])}']`)
  const alpha = filePane(window, "src/alpha.ts")
  // Let highlighting and the first layout settle before measuring.
  await window.waitForTimeout(1_000)
  await watchPane(filesView, "files")
  await watchPane(alpha, "alpha")

  await openTab(window, "src/beta.ts")
  await expect(window.getByTestId("surface-view")).toHaveAttribute("data-panes", "3")
  await window.waitForTimeout(1_000)
  const churn = {
    files: await paneChurn(filesView, "files"),
    alpha: await paneChurn(alpha, "alpha")
  }
  expect(churn.alpha).toEqual({ mutations: 0, sameCode: true })
  expect(churn.files).toEqual({ mutations: 0, sameCode: true })
})
