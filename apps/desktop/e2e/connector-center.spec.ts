import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { expect, test } from "./fixtures.js"

/**
 * MCP Connector Center, end to end against the built app.
 *
 * Hermetic by construction: a local fake OpenConnector HTTP server stands in for a
 * real instance (the app's main process fetches it — Playwright can't intercept
 * main-process fetch, so a real server is the honest fixture), and the endpoint +
 * token are seeded into `~/starbase` before the panel opens. Stateful: a PUT to
 * `/api/connections/:service` shows up on the next `GET /api/connections`, so the
 * connect flow is observable the way the operator sees it.
 *
 * Run locally: `pnpm --filter @starbase/desktop e2e` (the `_electron` suite is not
 * in CI). Asserts on what the operator sees, never on internals.
 */

const SECRET = "sk-oc-E2E-MUST-NOT-LEAK"

/** A stateful fake OpenConnector: a provider catalog + a mutable connection set. */
const startFakeOpenConnector = async (): Promise<{ server: Server; port: number }> => {
  const connected = new Set<string>()
  const json = (res: import("node:http").ServerResponse, body: unknown) => {
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify(body))
  }
  const server = createServer((req, res) => {
    const url = req.url ?? ""
    // Every request must carry the bearer we seeded.
    if (req.headers.authorization !== "Bearer tok_e2e") {
      res.statusCode = 401
      return res.end("unauthorized")
    }
    if (req.method === "GET" && url.startsWith("/v1/providers")) {
      return json(res, {
        data: [
          { id: "github", name: "GitHub", actionCount: 42, auth: [{ type: "api_key", fields: [{ name: "apiKey", label: "Token", type: "password", required: true }] }] },
          { id: "slack", name: "Slack", actionCount: 18, auth: [{ type: "oauth2" }] }
        ]
      })
    }
    if (req.method === "GET" && url.startsWith("/api/connections")) {
      return json(res, {
        data: [...connected].map((service) => ({ service, accountId: `${service}_acct`, displayName: `${service} account`, grantedScopes: [] }))
      })
    }
    if (req.method === "GET" && url.startsWith("/api/oauth/configs")) {
      return json(res, { data: [] })
    }
    if (req.method === "PUT" && url.startsWith("/api/connections/")) {
      const service = decodeURIComponent(url.split("/").pop() ?? "")
      connected.add(service)
      return json(res, { success: true })
    }
    if (req.method === "DELETE" && url.startsWith("/api/connections/")) {
      const service = decodeURIComponent((url.split("?")[0] ?? "").split("/").pop() ?? "")
      connected.delete(service)
      return json(res, { success: true })
    }
    res.statusCode = 404
    res.end("not found")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  return { server, port }
}

/** Open Settings and land on the Connector Center section. */
const openSettings = async (window: import("@playwright/test").Page) => {
  await expect(window.getByText("Sessions", { exact: true })).toBeVisible()
  await window.getByRole("button", { name: "Account menu" }).click()
  await window.getByRole("menuitem", { name: "Settings" }).click()
  await expect(window.getByRole("button", { name: "Close settings" })).toBeVisible()
}

/**
 * Configure OpenConnector through the Settings UI — the real operator flow. This
 * also sidesteps a file-seeding race: saving invalidates the shared config query,
 * which flips the Connector Center's catalog queries on with no restart.
 */
const configureUnifiedMcp = async (window: import("@playwright/test").Page, endpoint: string) => {
  await window.getByRole("button", { name: /Unified MCP/ }).click()
  await window.getByPlaceholder("https://mcp.internal").fill(endpoint)
  await window.getByPlaceholder("Paste the instance token").fill("tok_e2e")
  await window.getByRole("switch").click()
  await window.getByRole("button", { name: "Save" }).click()
}

test("browse, connect, and disconnect a provider through the Connector Center", async ({ launchApp }) => {
  const { server, port } = await startFakeOpenConnector()
  try {
    const app = await launchApp({ configured: true })

    await openSettings(app.window)
    await configureUnifiedMcp(app.window, `http://127.0.0.1:${port}`)

    // Now open the Connector Center — its catalog reads are gated on the config above.
    await app.window.getByRole("button", { name: /Connector Center/ }).click()

    // Catalog loads from the fake instance. `exact` because each row also renders a
    // mono "<id> · N actions" subtitle, so a substring match would resolve to two.
    await expect(app.window.getByText("GitHub", { exact: true })).toBeVisible()
    await expect(app.window.getByText("Slack", { exact: true })).toBeVisible()

    // Search filters.
    await app.window.getByLabel("Search providers").fill("git")
    await expect(app.window.getByText("Slack", { exact: true })).toHaveCount(0)

    // Connect GitHub with an API key.
    await app.window.getByText("GitHub", { exact: true }).click()
    const dialog = app.window.getByRole("dialog")
    await dialog.getByPlaceholder("Token").fill(SECRET)
    await dialog.getByRole("button", { name: "Connect" }).click()

    // The connection appears (GET /api/connections now returns it).
    await expect(app.window.getByText("github account")).toBeVisible()

    // The API key must never surface as rendered text (the value is write-only). A
    // DOM-text check, not page.content() — an <input> value is a live property that
    // never serialises into the HTML string, so that assertion was vacuous.
    await expect(app.window.getByText(SECRET, { exact: false })).toHaveCount(0)

    // Disconnect.
    await app.window.getByRole("button", { name: "Disconnect" }).click()
    await expect(app.window.getByText("github account")).toHaveCount(0)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
