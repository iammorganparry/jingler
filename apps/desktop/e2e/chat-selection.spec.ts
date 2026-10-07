import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { appShell, expect, test, type LaunchOptions } from "./fixtures.js"
import type { Menu } from "electron"

const prose = "Select this chat output and copy it."
const url = "https://example.com/selection"
type ContextMenuRecorder = typeof globalThis & { __chatMenu?: Menu; __chatMenuPopups: number }
type ExternalOpenRecorder = typeof globalThis & { __chatSelectionOpened: string[] }

const selectionApp: LaunchOptions = {
  configured: true,
  withRepo: true,
  seed: ({ repoPath }) => writeFileSync(join(repoPath, "notes.md"), "# Selection notes\n"),
  sessions: ({ repoPath }) => [{
    id: "s_selection", repo: "widget", branch: "jingler/selection", title: "Select chat output",
    status: "idle", diff: { added: 0, removed: 0 }, prNumber: null, costUsd: 0, tokens: 0,
    updatedAt: "2026-08-05T00:00:00.000Z", worktreePath: repoPath, mode: "accept-edits"
  }],
  transcripts: { s_selection: [{
    id: "a_selection", role: "assistant", streaming: false, createdAt: "2026-08-05T00:00:00.000Z",
    parts: [{ _tag: "Text", text: `${prose}\n\n[${url}](${url})\n\nOpen \`notes.md\` or [selection notes](./notes.md).` }]
  }] }
}

test("chat output and links can be selected and copied", async ({ launchApp }) => {
  const { window, app } = await launchApp(selectionApp)
  await app.evaluate(({ shell }) => {
    const recorder = globalThis as ExternalOpenRecorder
    recorder.__chatSelectionOpened = []
    shell.openExternal = async openedUrl => { recorder.__chatSelectionOpened.push(openedUrl) }
  })
  await expect(appShell(window)).toBeVisible()
  const cdp = await window.context().newCDPSession(window)
  // Hidden Electron windows need active-page emulation for native focus styling.
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true })
  const transcript = window.getByTestId("conversation-scroll")
  await expect(transcript.getByRole("link", { name: "notes.md", exact: true })).toBeVisible()
  for (const text of [prose, url, "notes.md", "selection notes"]) {
    for (const forward of [true, false]) {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.focus())
      await window.evaluate(() => window.getSelection()?.removeAllRanges())
      const target = transcript.getByText(text, { exact: true })
      await expect(target).toBeVisible()
      const box = await target.evaluate(el => {
        const node = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode()
        if (!node) throw new Error("Chat text has no text node")
        const range = document.createRange()
        range.selectNodeContents(node)
        const rect = range.getBoundingClientRect()
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      })
      await window.mouse.move(box.x + (forward ? 0.1 : box.width - 0.1), box.y + box.height / 2)
      await window.mouse.down()
      const { nodes } = await cdp.send("Accessibility.getFullAXTree") as {
        nodes: Array<{ ignored: boolean; role?: { value?: string }; name?: { value?: string } }>
      }
      const accessibleLinks = nodes.filter(node => !node.ignored && node.role?.value === "link").map(node => node.name?.value)
      expect(accessibleLinks).toEqual(expect.arrayContaining(["notes.md", "selection notes"]))
      await window.mouse.move(box.x + (forward ? box.width - 0.1 : 0.1), box.y + box.height / 2, { steps: 15 })
      await window.mouse.up()
      await expect.poll(() => window.evaluate(() => window.getSelection()?.toString())).toBe(text)
      await window.keyboard.press(process.platform === "darwin" ? "Meta+c" : "Control+c")
      await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(text)
      expect(await app.evaluate(() => (globalThis as ExternalOpenRecorder).__chatSelectionOpened)).toEqual([])
      await expect(window.getByTestId("editor-body-file-notes.md")).toHaveCount(0)
    }
  }
  await window.evaluate(() => window.getSelection()?.removeAllRanges())
  const externalLink = transcript.getByRole("link", { name: url, exact: true })
  await externalLink.click()
  await expect.poll(() => app.evaluate(() => (globalThis as ExternalOpenRecorder).__chatSelectionOpened)).toEqual([url])
  await externalLink.focus()
  for (const name of ["notes.md", "selection notes"]) {
    await window.keyboard.press("Tab")
    const link = transcript.getByRole("link", { name, exact: true })
    await expect(link).toBeFocused()
    expect(await link.evaluate(el => {
      const style = getComputedStyle(el)
      return { style: style.outlineStyle, width: style.outlineWidth }
    })).toEqual({ style: "solid", width: "2px" })
  }
  await window.keyboard.press("Enter")
  await expect(window.getByTestId("editor-body-file-notes.md")).toBeVisible()
  expect(await app.evaluate(() => (globalThis as ExternalOpenRecorder).__chatSelectionOpened)).toEqual([url])
  await cdp.detach()
})

test("right-click offers native text and link actions without replacing app menus", async ({ launchApp }) => {
  const { window, app } = await launchApp(selectionApp)
  await expect(appShell(window)).toBeVisible()
  await app.evaluate(({ Menu }) => {
    const recorder = globalThis as ContextMenuRecorder
    recorder.__chatMenuPopups = 0
    Menu.prototype.popup = function () {
      recorder.__chatMenu = this
      recorder.__chatMenuPopups++
    }
  })
  const cdp = await window.context().newCDPSession(window)
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true })
  const transcript = window.getByTestId("conversation-scroll")
  const text = transcript.getByText(prose, { exact: true })
  await expect(text).toBeVisible()
  const box = await text.boundingBox()
  if (!box) throw new Error("Chat prose has no bounding box")
  await window.mouse.move(box.x + 2, box.y + box.height / 2)
  await window.mouse.down()
  await window.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 15 })
  await window.mouse.up()
  await expect.poll(() => window.evaluate(() => window.getSelection()?.toString())).toBe(prose)
  await window.mouse.click(box.x + 10, box.y + box.height / 2, { button: "right" })
  await expect.poll(() => app.evaluate(() =>
    (globalThis as ContextMenuRecorder).__chatMenu?.items.map(item => ({ role: item.role, enabled: item.enabled }))
  )).toEqual([{ role: "copy", enabled: true }])
  await expect.poll(() => window.evaluate(() => window.getSelection()?.toString())).toBe(prose)

  await window.evaluate(() => window.getSelection()?.removeAllRanges())
  await transcript.getByRole("link", { name: url, exact: true }).click({ button: "right" })
  await expect.poll(() => app.evaluate(() =>
    (globalThis as ContextMenuRecorder).__chatMenu?.items.map(item => item.label)
  )).toContain("Copy Link Address")
  await app.evaluate(({ BrowserWindow }) => {
    const item = (globalThis as ContextMenuRecorder).__chatMenu?.items.find(entry => entry.label === "Copy Link Address")
    const host = BrowserWindow.getAllWindows()[0]
    item?.click({}, host, host?.webContents)
  })
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(url)

  const composer = window.getByPlaceholder("Message the agent…")
  await composer.click({ button: "right" })
  await expect.poll(() => app.evaluate(() =>
    (globalThis as ContextMenuRecorder).__chatMenu?.items.map(item => item.role)
  )).toEqual(["cut", "copy", "paste", "selectall"])

  const nativePopups = await app.evaluate(() => (globalThis as ContextMenuRecorder).__chatMenuPopups)
  await window.getByTestId("session-row-s_selection").click({ button: "right" })
  await expect(window.getByRole("menu", { name: "Actions" })).toBeVisible()
  expect(await app.evaluate(() => (globalThis as ContextMenuRecorder).__chatMenuPopups)).toBe(nativePopups)
  await window.keyboard.press("Escape")
  await cdp.detach()
})
