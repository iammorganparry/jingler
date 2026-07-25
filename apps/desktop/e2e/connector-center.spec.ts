import { expect, test } from "./fixtures.js"
import { FAKE_TOKEN, startFakeOpenConnector } from "./fake-open-connector.js"

/**
 * MCP Connector Center, end to end against the built app.
 *
 * Hermetic by construction: a local fake OpenConnector HTTP server stands in for a
 * real instance (the app's main process fetches it — Playwright can't intercept
 * main-process fetch, so a real server is the honest fixture), and the endpoint +
 * token are entered through the real Settings flow. Stateful: a PUT to
 * `/api/connections/:service` shows up on the next `GET /api/connections`, so the
 * connect flow is observable the way the operator sees it.
 *
 * Run locally: `pnpm --filter @starbase/desktop e2e` (the `_electron` suite is not
 * in CI). Asserts on what the operator sees, never on internals.
 */

const SECRET = "sk-oc-E2E-MUST-NOT-LEAK"

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
 *
 * There is ONE MCP entry now (Connectors); the setup form is what it shows until a
 * live probe connects, so configuring and passing the gate are the same screen.
 */
const configureUnifiedMcp = async (window: import("@playwright/test").Page, endpoint: string) => {
  await window.getByRole("button", { name: /Connectors/ }).click()
  await window.getByPlaceholder("https://mcp.internal").fill(endpoint)
  await window.getByPlaceholder("Paste the instance token").fill(FAKE_TOKEN)
  await window.getByRole("switch", { name: "Enable the shared MCP server" }).click()
  await window.getByRole("button", { name: "Save" }).click()
  // The gate is a live probe, not saved config — Test is what opens the catalog.
  await window.getByRole("button", { name: /^Test/ }).click()
}

test("browse, connect, and disconnect a provider through the Connector Center", async ({ launchApp }) => {
  const instance = await startFakeOpenConnector()
  try {
    const app = await launchApp({ configured: true })

    await openSettings(app.window)

    // Before any connection: the setup view, NOT an empty catalog.
    await app.window.getByRole("button", { name: /Connectors/ }).click()
    await expect(app.window.getByLabel("Search providers")).toHaveCount(0)

    await configureUnifiedMcp(app.window, instance.endpoint)

    // Catalog loads from the fake instance. Scoped to the catalog region: "GitHub"
    // is ALSO a Settings nav entry, so an unscoped by-name lookup is ambiguous.
    const catalog = app.window.getByRole("group", { name: "Provider catalog" })
    await expect(catalog.getByRole("button", { name: "GitHub" })).toBeVisible()
    await expect(catalog.getByRole("button", { name: "Slack" })).toBeVisible()

    // The `no_auth` provider is connected on arrival — it needs no credential, so
    // the split is 1 connected / 3 not before the operator does anything.
    await expect(app.window.getByRole("tab", { name: /Connected 1/ })).toBeVisible()

    // Search filters.
    await app.window.getByLabel("Search providers").fill("git")
    await expect(catalog.getByRole("button", { name: "Slack" })).toHaveCount(0)

    // Connect GitHub with an API key.
    await catalog.getByRole("button", { name: "GitHub" }).click()
    const dialog = app.window.getByRole("dialog")
    // The provider's OWN placeholder, fetched from `/api/providers/github`. It is
    // not the generic "API key" fallback: that fallback is what every provider
    // used to get, because the catalog LIST response carries no field list at all.
    await dialog.getByPlaceholder("ghp_...").fill(SECRET)
    await dialog.getByRole("button", { name: "Connect" }).click()

    // The connection appears (GET /api/connections now returns it). The tab counts
    // are scoped to the SEARCH, so clear it first — with "git" still typed,
    // "Connected 1" would be the honest answer and prove nothing about the total.
    await app.window.getByLabel("Search providers").fill("")
    await expect(app.window.getByRole("tab", { name: /Connected 2/ })).toBeVisible()

    // Reopen the card: the account name is read out of the response's nested
    // `profile`, which the mapper used to look for at the root and render blank.
    await catalog.getByRole("button", { name: "GitHub" }).click()
    await expect(app.window.getByText("github account")).toBeVisible()

    // The API key must never surface as rendered text (the value is write-only). A
    // DOM-text check, not page.content() — an <input> value is a live property that
    // never serialises into the HTML string, so that assertion was vacuous.
    await expect(app.window.getByText(SECRET, { exact: false })).toHaveCount(0)

    // Disconnect.
    await app.window.getByRole("button", { name: "Disconnect" }).click()
    await expect(app.window.getByText("github account")).toHaveCount(0)
  } finally {
    await instance.close()
  }
})
