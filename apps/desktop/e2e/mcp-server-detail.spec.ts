import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Page } from "@playwright/test"
import { expect, test } from "./fixtures.js"
import { startFakeOAuthMcpServer } from "./fake-oauth-mcp-server.js"

const paperServer = join(import.meta.dirname, "fake-paper-mcp.mjs")

const openMcpSettings = async (window: Page): Promise<void> => {
  await window.getByRole("button", { name: "Account menu" }).click()
  await window.getByRole("menuitem", { name: "Settings" }).click()
  await window.getByRole("button", { name: "MCP servers", exact: true }).click()
}

test("a tool turned off in the server detail dialog stays off after reopening", async ({ launchApp }) => {
  const { window, home } = await launchApp({
    configured: true,
    withRepo: true,
    seed: ({ home }) => {
      const root = join(home, "jingler")
      mkdirSync(root, { recursive: true })
      writeFileSync(join(root, "mcp.json"), JSON.stringify({
        mcp: { paper: { type: "local", command: [process.execPath, paperServer], enabled: true } }
      }))
    }
  })

  await openMcpSettings(window)
  await window.getByRole("button", { name: "Test connections" }).click()
  const openTools = async () => {
    await window.getByRole("button", { name: "Open paper details" }).click()
    await window.getByRole("dialog").getByRole("tab", { name: /^Tools/ }).click()
  }
  await expect(window.getByText("1 tools", { exact: true })).toBeVisible({ timeout: 20_000 })
  await openTools()

  const toggle = () => window.getByRole("dialog").getByRole("switch", { name: "Enable tool inspect_design" })
  await expect(toggle()).toBeChecked({ timeout: 20_000 })
  await toggle().click()
  await expect(toggle()).not.toBeChecked()

  const disabledTools = () =>
    (JSON.parse(readFileSync(join(home, "jingler", "mcp.json"), "utf8")).mcp.paper.disabledTools ?? []) as ReadonlyArray<string>
  await expect.poll(disabledTools).toEqual(["inspect_design"])

  await window.keyboard.press("Escape")
  await expect(window.getByRole("dialog")).toHaveCount(0)
  await openTools()
  await expect(toggle()).not.toBeChecked()

  await toggle().click()
  await expect.poll(disabledTools).toEqual([])
})

test("Sign out in the server detail dialog clears only the OAuth credential", async ({ launchApp }) => {
  const mcp = await startFakeOAuthMcpServer()
  try {
    const { window, app, home } = await launchApp({
      configured: true,
      withRepo: true,
      seed: ({ home }) => {
        const root = join(home, "jingler")
        mkdirSync(root, { recursive: true })
        writeFileSync(join(root, "mcp.json"), JSON.stringify({
          mcp: { docs: { type: "remote", url: mcp.url, auth: { type: "oauth" }, enabled: true } }
        }))
      }
    })
    await openMcpSettings(window)

    await app.evaluate(({ shell }) => {
      ;(globalThis as unknown as { __opened: string[] }).__opened = []
      shell.openExternal = async (url: string) => {
        ;(globalThis as unknown as { __opened: string[] }).__opened.push(url)
      }
    })
    const reconnect = window.getByRole("button", { name: "Reconnect docs" })
    await reconnect.click()
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened.length)).toBe(1)
    const [authorizationUrl] = await app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened)
    expect(await (await fetch(authorizationUrl!)).text()).toContain("Connected")
    await expect(reconnect).toHaveCount(0, { timeout: 30_000 })

    // Reconnect hides as soon as authorization starts; the token lands a poll later.
    const dialog = window.getByRole("dialog")
    await expect(async () => {
      if ((await dialog.count()) > 0) await window.keyboard.press("Escape")
      await window.getByRole("button", { name: "Open docs details" }).click()
      await expect(dialog.getByRole("button", { name: "Sign out" })).toBeVisible({ timeout: 2_000 })
    }).toPass({ timeout: 30_000 })
    await dialog.getByRole("button", { name: "Sign out" }).click()

    await window.keyboard.press("Escape")
    await expect(reconnect).toBeVisible({ timeout: 30_000 })
    // The server config survives; only the credential went.
    const config = JSON.parse(readFileSync(join(home, "jingler", "mcp.json"), "utf8")).mcp.docs
    expect(config.url).toBe(mcp.url)
    expect(config.auth).toEqual({ type: "oauth" })
  } finally {
    await mcp.close()
  }
})
