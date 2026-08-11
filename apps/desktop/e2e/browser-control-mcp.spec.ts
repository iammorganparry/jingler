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
  const targetServer = createServer((request, response) => {
    const path = request.url ?? ""
    requests.push(path)
    if (path === "/browser-pi") {
      response.writeHead(302, { Location: "/browser-pi-final" })
      response.end()
      return
    }
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
    const { window } = await launchApp({
      configured: true,
      withRepo: true,
      piFixture: { scenarioId: "browser-control", authRoute: "api-key" },
      sessions: session
    })

    await expect(appShell(window)).toBeVisible()
    const composer = window.getByPlaceholder(/message/i)
    await composer.fill(`Navigate the operator's Preview. [[browser-url=${targetUrl}]]`)
    await composer.press("Enter")

    await expect(window.getByText("Browser workflow completed through pi.")).toBeVisible({
      timeout: 20_000
    })
    await expect(window.getByRole("button", { name: "Browser", exact: true })).toHaveAttribute(
      "aria-current",
      "page"
    )
    await expect(window.getByLabel("Preview URL")).toHaveValue(
      `http://127.0.0.1:${address.port}/browser-pi-final`
    )
    expect(requests.filter((path) => path === "/browser-pi")).toHaveLength(1)
    expect(requests.filter((path) => path === "/browser-pi-final")).toHaveLength(1)
  } finally {
    await closeServer(targetServer)
  }
})
