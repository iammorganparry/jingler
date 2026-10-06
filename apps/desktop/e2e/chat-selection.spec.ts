import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { appShell, expect, test } from "./fixtures.js"

const prose = "Select this chat output and copy it."
const url = "https://example.com/selection"

test("chat output and links can be selected and copied", async ({ launchApp }) => {
  const { window, app } = await launchApp({
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
  })
  await expect(appShell(window)).toBeVisible()
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
      await window.mouse.move(box.x + (forward ? box.width - 0.1 : 0.1), box.y + box.height / 2, { steps: 15 })
      await window.mouse.up()
      await expect.poll(() => window.evaluate(() => window.getSelection()?.toString())).toBe(text)
      await window.keyboard.press(process.platform === "darwin" ? "Meta+c" : "Control+c")
      await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(text)
    }
  }
})
