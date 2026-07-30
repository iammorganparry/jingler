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
    branch: "jingler/browser-mcp",
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
    requests.push(request.url ?? "")
    response.writeHead(200, { "Content-Type": "text/html" })
    response.end("<!doctype html><title>Browser MCP parity</title><h1>Native Preview reached</h1>")
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

  try {
    const { window, codexCalls } = await launchApp({
      configured: true,
      withRepo: true,
      sessions: session,
      scriptedAgent: false
    })

    await expect(appShell(window)).toBeVisible()
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
          "browser-mcp:initialize",
          "browser-mcp:tools/call:navigate"
        ])
      )

    await expect(window.getByRole("button", { name: "Hide preview" })).toBeVisible()
    await expect(window.getByLabel("Preview URL")).toHaveValue(targetUrl)
    await expect
      .poll(() => requests, { timeout: 10_000 })
      .toContain("/browser-mcp-parity")
  } finally {
    await closeServer(targetServer)
  }
})
