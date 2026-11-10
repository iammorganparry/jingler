import { existsSync } from "node:fs"
import { join } from "node:path"
import type { Page } from "@playwright/test"
import { appShell, expect, test, type SeedSession } from "./fixtures.js"

const QUERY = "error+[error]"
const DATE = "2026-11-07T00:00:00.000Z"
const AUTO = /^Auto\b/u
const COMMAND_TAB = /^printf/u
const sessions = ({ repoPath }: { repoPath: string }): ReadonlyArray<SeedSession> => [{
  id: "terminal-find", title: "Terminal Find", repo: "widget", repoPath, worktreePath: repoPath,
  branch: "main", workspaceMode: "direct", status: "idle", diff: { added: 0, removed: 0 },
  prNumber: null, costUsd: 0, tokens: 0, updatedAt: DATE, mode: "accept-edits"
}]

/** Octal keeps the query out of the echoed command, so counts prove actual output matches. */
const printOutput = async (window: Page, text: string) => {
  const encoded = [...Buffer.from(text)].map((byte) => `\\${byte.toString(8).padStart(3, "0")}`).join("")
  const input = window.getByRole("textbox", { name: "Terminal input", exact: true })
  await input.click()
  await window.keyboard.type(`printf '${encoded}'`)
  await window.keyboard.press("Enter")
}
const openTerminal = async (window: Page) => {
  await expect(appShell(window)).toBeVisible()
  await window.getByTestId("header-view-terminal").click()
  await expect(window.locator(".xterm").first()).toBeVisible()
}
const findField = (window: Page) => window.getByPlaceholder("Find in terminal…", { exact: true })
const findCount = (window: Page) => window.getByRole("region", { name: "Find in terminal", exact: true }).getByRole("status")

test("Find searches real output literally, wraps through matches, and returns keyboard control to the shell", async ({ launchApp }, testInfo) => {
  const { window, repoPath } = await launchApp({ configured: true, withRepo: true, sessions })
  await openTerminal(window)
  await printOutput(window, `${QUERY} first\n${QUERY} second\n${QUERY} third\n`)
  await window.keyboard.press("Meta+f")
  const find = findField(window)
  await expect(find).toBeFocused()
  await expect(window.getByRole("dialog", { name: "Command palette" })).toHaveCount(0)
  await find.fill(QUERY)
  const count = findCount(window)
  await expect(count).toHaveText("1 of 3")
  await find.press("Enter")
  await expect(count).toHaveText("2 of 3")
  await find.press("Shift+Enter")
  await expect(count).toHaveText("1 of 3")
  await find.press("Shift+Enter")
  await expect(count).toHaveText("3 of 3")
  await window.setViewportSize({ width: 900, height: 600 })
  const bounds = await window.getByRole("region", { name: "Find in terminal" }).boundingBox()
  expect(bounds).not.toBeNull()
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(900)
  await window.screenshot({ path: testInfo.outputPath("terminal-find.png") })
  await find.press("Escape")
  await expect(find).toHaveCount(0)
  await expect(window.getByRole("textbox", { name: "Terminal input", exact: true })).toBeFocused()
  await window.keyboard.type("printf resumed > find-resumed.txt")
  await window.keyboard.press("Enter")
  await expect.poll(() => existsSync(join(repoPath!, "find-resumed.txt"))).toBe(true)
  await window.keyboard.press("Control+f")
  await expect(find).toHaveValue(QUERY)
  await expect(find).toBeFocused()
  await find.fill("nothing-in-this-buffer")
  await expect(count).toHaveText("No matches")
  await find.press("Tab")
  await expect(window.getByRole("button", { name: "Clear", exact: true })).toBeFocused()
  await window.keyboard.press("Enter")
  await expect(find).toHaveValue("")
  await expect(find).toBeFocused()
  await find.press("Escape")
})

test("Find state belongs to one terminal and closes when switching tabs", async ({ launchApp }) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions })
  await openTerminal(window)
  await printOutput(window, `${QUERY} in the first terminal\n`)
  await window.keyboard.press("Meta+f")
  await findField(window).fill(QUERY)
  await expect(findCount(window)).toHaveText("1 of 1")
  await window.getByRole("button", { name: "New tab", exact: true }).last().click()
  await window.getByTestId("new-tab-option-terminal").click()
  await expect(window.getByRole("tab", { name: "zsh 2", exact: true })).toBeVisible()
  await expect(findField(window)).toHaveCount(0)
  await printOutput(window, "second-terminal-only\n")
  await window.keyboard.press("Meta+f")
  await expect(findField(window)).toHaveValue("")
  await findField(window).fill(QUERY)
  await expect(findCount(window)).toHaveText("No matches")
  await window.getByRole("tab", { name: "zsh", exact: true }).click()
  await expect(findField(window)).toHaveCount(0)
  await window.getByRole("textbox", { name: "Terminal input", exact: true }).click()
  await window.keyboard.press("Meta+f")
  await expect(findField(window)).toHaveValue(QUERY)
  await expect(findCount(window)).toHaveText("1 of 1")
})

test("Find works in an agent command's read-only terminal", async ({ launchApp }) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions })
  await expect(appShell(window)).toBeVisible()
  const composer = window.getByPlaceholder("Message the agent…")
  await composer.click()
  await window.getByRole("button", { name: "Accept Edits", exact: true }).click()
  await window.getByRole("option", { name: AUTO }).click()
  await composer.fill("Add rate limiting.")
  await composer.press("Enter")
  await expect(window.getByText("Implemented rate limiting and verified 1 passed.")).toBeVisible({ timeout: 25_000 })
  const watch = window.getByRole("button", { name: "Watch in terminal" }).first()
  if (!(await watch.isVisible())) await window.getByText("printf '1 passed\\n'").first().click()
  await watch.click()
  await expect(window.getByRole("tab", { name: COMMAND_TAB })).toBeVisible()
  await window.locator(".xterm").first().click()
  await window.keyboard.press("Meta+f")
  await findField(window).fill("passed")
  await expect(findCount(window)).toHaveText("1 of 1")
  await findField(window).press("Escape")
  await expect(findField(window)).toHaveCount(0)
  await expect(window.getByTestId("terminal-exited").getByRole("button", { name: "Restart" })).toHaveCount(0)
})
