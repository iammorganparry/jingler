import type { Page } from "@playwright/test"
import { appShell, expect, test } from "./fixtures.js"

/**
 * The app against a REAL OpenConnector — the one from `docker compose up -d
 * open-connector`.
 *
 * Every other spec in this suite runs against a fake, which is the right default:
 * hermetic, fast, no network. But a fake only ever proves the app agrees with
 * itself. The failures this catches are the ones a fixture cannot: the live
 * catalog's field names, a protocol version the real MCP server negotiates
 * differently, an auth header the image rejects. It has already earned its keep —
 * the fake originally served a provider shape (`id`/`name`/`auth[].fields`) the
 * real instance never sends.
 *
 * SKIPPED, not failed, when the container isn't up: this is not a test of whether
 * the developer happens to be running Docker. Bring it up with
 * `docker compose up -d open-connector`, then
 * `pnpm --filter @jingler/desktop e2e open-connector-live`.
 */

const ENDPOINT = process.env.JINGLER_E2E_OPEN_CONNECTOR_URL ?? "http://localhost:3000"
const TOKEN = process.env.JINGLER_E2E_OPEN_CONNECTOR_TOKEN ?? "local-dev-token"

/** Is the instance up AND accepting our token? Both, or the spec is meaningless. */
const instanceReachable = async (): Promise<boolean> => {
  try {
    const res = await fetch(`${ENDPOINT}/v1/providers`, {
      headers: { authorization: `Bearer ${TOKEN}` },
      signal: AbortSignal.timeout(2000)
    })
    return res.ok
  } catch {
    return false
  }
}

const openConnectors = async (window: Page) => {
  await expect(appShell(window)).toBeVisible()
  await window.getByRole("button", { name: "Account menu" }).click()
  await window.getByRole("menuitem", { name: "Settings" }).click()
  await window.getByRole("button", { name: /Connectors/ }).click()
}

test("connects to the local OpenConnector and serves its real catalog to every agent", async ({
  launchApp
}) => {
  test.skip(!(await instanceReachable()), `No OpenConnector at ${ENDPOINT} — run docker compose up -d open-connector`)

  const app = await launchApp({ configured: true })
  await openConnectors(app.window)

  // The real operator flow, typed into the real fields.
  await app.window.getByPlaceholder("https://mcp.internal").fill(ENDPOINT)
  await app.window.getByPlaceholder("Paste the instance token").fill(TOKEN)
  await app.window.getByRole("switch", { name: "Enable the shared MCP server" }).click()
  await app.window.getByRole("button", { name: "Save" }).click()
  await app.window.getByRole("button", { name: /^Test/ }).click()

  // A live MCP handshake against the container: it reports its tool set, so the
  // gate opens on a real protocol exchange rather than on saved config.
  await expect(app.window.getByText(/Connected — [1-9]\d* tools/)).toBeVisible()

  // The real provider catalog loaded — hundreds of entries, so assert on search
  // rather than a count that shifts with every image release.
  await app.window.getByLabel("Search providers").fill("github")
  const catalog = app.window.getByRole("group", { name: "Provider catalog" })
  await expect(catalog.getByRole("button", { name: /GitHub/ }).first()).toBeVisible()

  // And the instance the agents get is the same one just proven reachable.
  for (const harness of ["Claude Code", "Codex", "opencode"]) {
    const row = app.window.getByLabel(harness, { exact: true })
    await expect(row.getByText("injected", { exact: true })).toBeVisible()
    await expect(row.getByText(`open-connector · ${ENDPOINT}/mcp`)).toBeVisible()
  }
})

/**
 * NOT a wrong-token case, deliberately.
 *
 * The obvious negative — bad bearer, expect a 401 — passes against the fake and
 * FAILS here: `ghcr.io/oomol-lab/open-connector` does not enforce
 * `OPEN_CONNECTOR_API_TOKEN` on `/v1/*` or `/mcp` (a wrong bearer, or none, still
 * returns 200), so the app cheerfully reports "connected" with a garbage token.
 * That is the instance's behaviour, not Jingler's bug, and it is why compose binds
 * the port to loopback. Asserting a 401 here would encode a guarantee the image
 * does not make. An unreachable endpoint is the failure that IS real.
 */
test("an unreachable endpoint fails closed — no catalog, and the reason says so", async ({
  launchApp
}) => {
  test.skip(!(await instanceReachable()), `No OpenConnector at ${ENDPOINT} — run docker compose up -d open-connector`)

  const app = await launchApp({ configured: true })
  await openConnectors(app.window)

  // Port 1 on loopback: nothing listens, so the probe cannot succeed by accident.
  await app.window.getByPlaceholder("https://mcp.internal").fill("http://127.0.0.1:1")
  await app.window.getByPlaceholder("Paste the instance token").fill(TOKEN)
  await app.window.getByRole("switch", { name: "Enable the shared MCP server" }).click()
  await app.window.getByRole("button", { name: "Save" }).click()
  await app.window.getByRole("button", { name: /^Test/ }).click()

  // The catalog stays shut. An unreachable instance is exactly the case that used
  // to render "Search 0 providers" and read as "no connectors exist".
  await expect(app.window.getByLabel("Search providers")).toHaveCount(0)
  await expect(app.window.getByText(/refused|fetch failed|could not|error/i).first()).toBeVisible()
})
