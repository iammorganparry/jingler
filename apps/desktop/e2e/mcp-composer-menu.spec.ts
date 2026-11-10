import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, openSessionByTitle, test } from "./fixtures.js"

const paperServer = join(import.meta.dirname, "fake-paper-mcp.mjs")

test("composer + › MCP turns a server off for this chat and the toggle sticks", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: [{
      id: "s_mcp_menu",
      repo: "widget",
      branch: "chore/mcp-menu",
      title: "MCP menu session",
      status: "idle",
      diff: { added: 0, removed: 0 },
      prNumber: null,
      costUsd: 0,
      tokens: 0,
      updatedAt: "2026-11-10T00:00:00.000Z"
    }],
    seed: ({ home }) => {
      const root = join(home, "jingler")
      mkdirSync(root, { recursive: true })
      writeFileSync(join(root, "mcp.json"), JSON.stringify({
        mcp: { paper: { type: "local", command: [process.execPath, paperServer], enabled: true } }
      }))
    }
  })
  await openSessionByTitle(window, "MCP menu session")

  const openMenu = async () => {
    await window.getByRole("button", { name: "Composer menu" }).click()
    await window.getByRole("option", { name: /^MCP/ }).click()
  }
  const toggle = () => window.getByRole("switch", { name: "Use paper in this chat" })

  await openMenu()
  await expect(window.getByRole("menu", { name: "MCP servers" })).toBeVisible()
  await expect(toggle()).toBeChecked()
  await toggle().click()
  await expect(toggle()).not.toBeChecked()

  // Persisted on the chat: closing and reopening reads it back from the session.
  await window.keyboard.press("Escape")
  await expect(window.getByRole("menu", { name: "MCP servers" })).toHaveCount(0)
  await openMenu()
  await expect(toggle()).not.toBeChecked()

  await toggle().click()
  await window.keyboard.press("Escape")
  await openMenu()
  await expect(toggle()).toBeChecked()
})
