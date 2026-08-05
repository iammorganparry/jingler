import { createServer, type Server } from "node:http"
import { appShell, expect, test } from "./fixtures.js"
import type { SeedSession } from "./fixtures.js"

/**
 * Native Preview browser parity through a real Codex child process.
 *
 * The fake Codex app-server does not receive a test-only MCP URL. It reads the
 * same `-c mcp_servers.jingler-browser.*` arguments Jingler gives a real Codex
 * process, authenticates to that endpoint, and calls `navigate` during the turn.
 * The target page is a real loopback server, so seeing its request proves the
 * native WebContentsView navigated — the renderer chrome alone cannot fake it.
 */

const session = ({ repoPath }: { repoPath: string }): ReadonlyArray<SeedSession> => [
  {
    id: "s_browser_mcp",
    repo: "widget",
    branch: "chore/browser-mcp",
    title: "Browser MCP parity",
    status: "idle",
    cli: "codex",
    diff: { added: 0, removed: 0 },
    prNumber: null,
    costUsd: 0,
    tokens: 0,
    updatedAt: "2026-07-30T00:00:00.000Z",
    worktreePath: repoPath,
    mode: "auto",
    model: "gpt-5.6-sol"
  }
]

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve) => {
    server.close(() => resolve())
    server.closeAllConnections()
  })

test("Codex drives the native Preview browser through jingler-browser", async ({ launchApp }) => {
  const requests: string[] = []
  const targetServer = createServer((request, response) => {
    const path = request.url ?? ""
    requests.push(path)
    if (path === "/browser-mcp-parity") {
      response.writeHead(302, { Location: "/browser-mcp-final" })
      response.end()
      return
    }
    response.writeHead(200, { "Content-Type": "text/html" })
    response.end(
      path === "/browser-mcp-final"
        ? "<!doctype html><title>Browser MCP parity</title><h1>Native Preview reached</h1>" +
            '<script>setTimeout(() => history.replaceState({}, "", "/browser-mcp-history"), 2000)</script>'
        : "<!doctype html><title>Browser MCP parity</title><h1>Initial Preview</h1>"
    )
  })
  await new Promise<void>((resolve, reject) => {
    targetServer.once("error", reject)
    targetServer.listen({ host: "127.0.0.1", port: 0 }, resolve)
  })
  const address = targetServer.address()
  if (address === null || typeof address === "string") {
    await closeServer(targetServer)
    throw new Error("Browser MCP target server has no TCP address")
  }
  const targetUrl = `http://127.0.0.1:${address.port}/browser-mcp-parity`
  const initialUrl = `http://127.0.0.1:${address.port}/already-open`

  try {
    const { window, codexCalls } = await launchApp({
      configured: true,
      withRepo: true,
      sessions: session,
      scriptedAgent: false
    })

    await expect(appShell(window)).toBeVisible()
    const previewToggle = window.getByRole("button", { name: "Preview", exact: true })
    if ((await previewToggle.getAttribute("aria-pressed")) !== "true") {
      await previewToggle.click()
    }
    const previewUrl = window.getByLabel("Preview URL")
    await previewUrl.fill(initialUrl)
    await previewUrl.press("Enter")
    await expect
      .poll(() => requests.filter((path) => path === "/already-open"))
      .toHaveLength(1)

    const composer = window.getByPlaceholder("Message Codex…")
    await composer.fill(`[[browser-control-mcp=${targetUrl}]] Navigate the operator's Preview.`)
    await composer.press("Enter")

    await expect(window.getByText("Codex browser MCP complete.")).toBeVisible({
      timeout: 20_000
    })
    await expect
      .poll(() => codexCalls(), { timeout: 10_000 })
      .toEqual(
        expect.arrayContaining([
          "permissions:auto",
          "browser-mcp:initialize",
          "browser-mcp:tools/call:navigate"
        ])
      )

    await expect(window.getByRole("button", { name: "Hide preview" })).toBeVisible()
    await expect(previewUrl).toHaveValue(
      `http://127.0.0.1:${address.port}/browser-mcp-final`
    )
    await expect(previewUrl).toHaveValue(
      `http://127.0.0.1:${address.port}/browser-mcp-history`,
      { timeout: 10_000 }
    )
    await expect
      .poll(
        () => requests.filter((path) => path === "/browser-mcp-parity").length,
        { timeout: 10_000 }
      )
      .toBe(1)
    expect(requests.filter((path) => path === "/browser-mcp-final")).toHaveLength(1)
  } finally {
    await closeServer(targetServer)
  }
})
