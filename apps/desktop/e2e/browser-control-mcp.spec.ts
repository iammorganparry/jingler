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

const splitSessions = ({ repoPath }: { repoPath: string }): ReadonlyArray<SeedSession> => [
  {
    ...session({ repoPath })[0]!,
    id: "s_browser_alpha",
    branch: "jingler/browser-alpha",
    title: "Browser Alpha"
  },
  {
    ...session({ repoPath })[0]!,
    id: "s_browser_beta",
    branch: "jingler/browser-beta",
    title: "Browser Beta"
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
    await window.getByRole("button", { name: "Browser", exact: true }).click()
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

    await expect(window.getByRole("button", { name: "Browser", exact: true })).toHaveAttribute(
      "aria-current",
      "page"
    )
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

test("a background Codex run updates only its owning session browser", async ({ launchApp }) => {
  const requests: string[] = []
  const targetServer = createServer((request, response) => {
    const path = request.url ?? ""
    requests.push(path)
    response.writeHead(200, { "Content-Type": "text/html" })
    response.end(`<!doctype html><title>${path}</title><h1>${path}</h1>`)
  })
  await new Promise<void>((resolve, reject) => {
    targetServer.once("error", reject)
    targetServer.listen({ host: "127.0.0.1", port: 0 }, resolve)
  })
  const address = targetServer.address()
  if (address === null || typeof address === "string") {
    await closeServer(targetServer)
    throw new Error("Browser isolation target server has no TCP address")
  }
  const betaUrl = `http://127.0.0.1:${address.port}/beta-focused`
  const alphaUrl = `http://127.0.0.1:${address.port}/alpha-background`

  try {
    const { app, window, releaseBrowserMcp } = await launchApp({
      configured: true,
      withRepo: true,
      sessions: splitSessions,
      scriptedAgent: false
    })
    await expect(appShell(window)).toBeVisible()
    await window.keyboard.press("Control+Shift+Equal")
    const alphaPane = window.getByTestId("split-pane-0")
    const betaPane = window.getByTestId("split-pane-1")
    await expect(betaPane).toHaveAttribute("data-focused", "true")

    const betaComposer = betaPane.getByPlaceholder("Message Codex…")
    await betaComposer.fill(`[[browser-control-mcp=${betaUrl}]] QA Beta concurrently.`)
    await betaComposer.press("Enter")

    await window.keyboard.press("Control+Shift+Digit1")
    await expect(alphaPane).toHaveAttribute("data-focused", "true")
    const alphaComposer = alphaPane.getByPlaceholder("Message Codex…")
    await alphaComposer.fill(
      `[[browser-control-mcp=${alphaUrl}]][[browser-control-mcp-gated]] QA Alpha in the background.`
    )
    await alphaComposer.press("Enter")

    // The fake harness is held at an explicit barrier until focus has moved, so
    // Alpha's native view is created deterministically as a background operation.
    await window.keyboard.press("Control+Shift+Digit2")
    await expect(betaPane).toHaveAttribute("data-focused", "true")
    releaseBrowserMcp()
    const previewUrl = betaPane.getByLabel("Preview URL")
    await expect.poll(() => requests.filter((path) => path === "/beta-focused")).toHaveLength(1)
    await expect.poll(() => requests.filter((path) => path === "/alpha-background")).toHaveLength(1)
    await expect(previewUrl).toHaveValue(betaUrl)
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }, urls) => {
          const root = BrowserWindow.getAllWindows()[0]?.contentView
          return Object.fromEntries(
            (root?.children ?? [])
              .map((view) => {
                const candidate = view as typeof view & {
                  webContents?: { getURL(): string }
                }
                return [candidate.webContents?.getURL() ?? "", view.getVisible()] as const
              })
              .filter(([url]) => url === urls.alpha || url === urls.beta)
          )
        }, { alpha: alphaUrl, beta: betaUrl })
      )
      .toEqual({ [alphaUrl]: true, [betaUrl]: true })

    await window.keyboard.press("Control+Shift+Digit1")
    await expect(alphaPane).toHaveAttribute("data-focused", "true")
    await expect(alphaPane.getByLabel("Preview URL")).toHaveValue(alphaUrl, { timeout: 10_000 })
  } finally {
    await closeServer(targetServer)
  }
})

test("navigate resolves only after the new document is readable", async ({ launchApp }) => {
  const targetServer = createServer((_request, response) => {
    setTimeout(() => {
      response.writeHead(200, { "Content-Type": "text/html" })
      response.end("<!doctype html><title>delayed</title><h1>Delayed document ready</h1>")
    }, 1_000)
  })
  await new Promise<void>((resolve, reject) => {
    targetServer.once("error", reject)
    targetServer.listen({ host: "127.0.0.1", port: 0 }, resolve)
  })
  const address = targetServer.address()
  if (address === null || typeof address === "string") {
    await closeServer(targetServer)
    throw new Error("Delayed navigation server has no TCP address")
  }
  const targetUrl = `http://127.0.0.1:${address.port}/delayed`

  try {
    const { window, codexCalls } = await launchApp({
      configured: true,
      withRepo: true,
      sessions: session,
      scriptedAgent: false
    })
    await expect(appShell(window)).toBeVisible()
    const composer = window.getByPlaceholder("Message Codex…")
    await composer.fill(`[[browser-control-mcp=${targetUrl}]] Read the delayed page.`)
    await composer.press("Enter")
    await expect(window.getByText("Codex browser MCP complete.")).toBeVisible({ timeout: 20_000 })
    await expect.poll(() => codexCalls()).toEqual(
      expect.arrayContaining([
        "browser-mcp:tools/call:navigate",
        "browser-mcp:tools/call:read_text:Delayed document ready"
      ])
    )
  } finally {
    await closeServer(targetServer)
  }
})
