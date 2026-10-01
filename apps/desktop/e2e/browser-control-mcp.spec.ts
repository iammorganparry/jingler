import { createServer, type Server } from "node:http"
import { appShell, expect, test, type SeedSession } from "./fixtures.js"

const session = ({ repoPath }: { repoPath: string }): ReadonlyArray<SeedSession> => [{
  id: "s_browser_mcp",
  repo: "widget",
  branch: "chore/browser-mcp",
  title: "Browser MCP parity",
  status: "idle",
  diff: { added: 0, removed: 0 },
  prNumber: null,
  costUsd: 0,
  tokens: 0,
  updatedAt: "2026-08-11T00:00:00.000Z",
  worktreePath: repoPath,
  mode: "auto"
}]

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve) => {
    server.close(() => resolve())
    server.closeAllConnections()
  })

test("pi drives the native Preview browser through the managed browser MCP", async ({
  launchApp
}) => {
  const requests: string[] = []
  let releasePage: () => void = () => {}
  const pageReleased = new Promise<void>((resolve) => {
    releasePage = resolve
  })
  const targetServer = createServer(async (request, response) => {
    const path = request.url ?? ""
    requests.push(path)
    if (path === "/browser-pi") {
      response.writeHead(302, { Location: "/browser-pi-final" })
      response.end()
      return
    }
    await pageReleased
    response.writeHead(200, { "Content-Type": "text/html" })
    response.end(
      "<!doctype html><title>Browser pi parity</title><h1>Native Preview reached through pi</h1>"
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
  const targetUrl = `http://127.0.0.1:${address.port}/browser-pi`

  try {
    const { app, window } = await launchApp({
      configured: true,
      withRepo: true,
      piFixture: { scenarioId: "browser-control", authRoute: "api-key" },
      sessions: session
    })

    await expect(appShell(window)).toBeVisible()
    await window.getByRole("button", { name: "Browser", exact: true }).click()
    if (process.env.JINGLER_E2E_HEADED !== "1") {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.emit("focus"))
    }
    const anyNativeViewVisible = () => app.evaluate(({ BrowserWindow }) =>
      (BrowserWindow.getAllWindows()[0]?.contentView.children ?? []).some((view) => view.getVisible()))
    await expect.poll(anyNativeViewVisible).toBe(true)
    if (process.env.JINGLER_E2E_HEADED === "1") {
      await expect.poll(() => app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]?.isFocused() ?? false)).toBe(true)
    }

    await window.locator('[data-testid^="editor-tab-chat-"]').first().getByRole("tab").click()
    const composer = window.getByPlaceholder(/message/i)
    await composer.fill(`Navigate the operator's Preview. [[browser-url=${targetUrl}]]`)
    await composer.press("Enter")
    await expect.poll(() => requests.includes("/browser-pi-final")).toBe(true)
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (process.env.JINGLER_E2E_HEADLESS === "1") win?.emit("blur")
      else win?.blur()
    })
    await expect.poll(anyNativeViewVisible).toBe(false)
    await expect.poll(() => app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.isFocused() ?? false)).toBe(false)
    releasePage()

    await expect(window.getByText("Browser workflow completed through pi.")).toBeVisible({
      timeout: 20_000
    })
    const nativeBrowserVisible = () => app.evaluate(({ BrowserWindow }, url) =>
      (BrowserWindow.getAllWindows()[0]?.contentView.children ?? []).some((view) => {
        const candidate = view as typeof view & { webContents?: { getURL(): string } }
        return candidate.webContents?.getURL() === url && view.getVisible()
      }), `http://127.0.0.1:${address.port}/browser-pi-final`)
    await expect.poll(nativeBrowserVisible).toBe(false)
    await expect.poll(() => app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.isFocused() ?? false)).toBe(false)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.emit("focus"))
    await window.getByTestId("editor-tab-view-browser").getByRole("tab").click()
    await expect.poll(nativeBrowserVisible).toBe(true)
    await expect(window.getByLabel("Preview URL")).toHaveValue(
      `http://127.0.0.1:${address.port}/browser-pi-final`
    )

    expect(requests.filter((path) => path === "/browser-pi")).toHaveLength(1)
    expect(requests.filter((path) => path === "/browser-pi-final")).toHaveLength(1)
  } finally {
    releasePage()
    await closeServer(targetServer)
  }
})
