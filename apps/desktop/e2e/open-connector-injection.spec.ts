import type { Page } from "@playwright/test"
import { expect, test } from "./fixtures.js"
import { FAKE_TOKEN, FAKE_TOOL_COUNT, startFakeOpenConnector } from "./fake-open-connector.js"

/**
 * "Do the connected tools actually reach claude / codex / opencode?"
 *
 * The Connector Center proves the app can talk to an instance. This proves the
 * other half of the promise — that a session on each harness really starts with
 * the unified server attached — because those are independent failures and the
 * settings screen looked identical for all of them: the master switch, a
 * per-harness opt-out, a missing token and a harness Starbase can't launch each
 * produce "connected" with no tools anywhere.
 *
 * The per-harness rows are resolved in main by `OpenConnector.injection`, which
 * calls the SAME `OpenConnectorService.injection(cli)` the agent runner calls at
 * spawn. So asserting the row asserts the launch, not a second implementation of
 * the rule that happens to agree.
 *
 * Run locally: `pnpm --filter @starbase/desktop e2e open-connector-injection`.
 */

const RUNNABLE = ["Claude Code", "Codex", "opencode"] as const

const openSettings = async (window: Page) => {
  await expect(window.getByText("Sessions", { exact: true })).toBeVisible()
  await window.getByRole("button", { name: "Account menu" }).click()
  await window.getByRole("menuitem", { name: "Settings" }).click()
  await expect(window.getByRole("button", { name: "Close settings" })).toBeVisible()
  await window.getByRole("button", { name: /Connectors/ }).click()
}

/** The operator's real setup flow: endpoint, token, enable, save, test. */
const connect = async (window: Page, endpoint: string, options: { token?: string } = {}) => {
  await window.getByPlaceholder("https://mcp.internal").fill(endpoint)
  if (options.token !== undefined) {
    await window.getByPlaceholder("Paste the instance token").fill(options.token)
  }
  await window.getByRole("switch", { name: "Enable the shared MCP server" }).click()
  await window.getByRole("button", { name: "Save" }).click()
  await window.getByRole("button", { name: /^Test/ }).click()
}

const row = (window: Page, harness: string) => window.getByLabel(harness, { exact: true })

test("every runnable harness reports the live endpoint it will be launched with", async ({
  launchApp
}) => {
  const instance = await startFakeOpenConnector()
  try {
    const app = await launchApp({ configured: true })
    await openSettings(app.window)

    // Before anything is configured, the rows say WHY — not merely "off".
    for (const harness of RUNNABLE) {
      await expect(row(app.window, harness).getByText("not injected")).toBeVisible()
    }
    await expect(row(app.window, "Claude Code").getByText(/Turn on Enable/)).toBeVisible()

    await connect(app.window, instance.endpoint, { token: FAKE_TOKEN })

    // The probe reached the instance and counted its tools.
    await expect(app.window.getByText(`Connected — ${FAKE_TOOL_COUNT} tools`)).toBeVisible()

    // …and every harness Starbase launches now carries the shared server.
    for (const harness of RUNNABLE) {
      await expect(row(app.window, harness).getByText("injected", { exact: true })).toBeVisible()
      await expect(
        row(app.window, harness).getByText(`open-connector · ${instance.endpoint}/mcp`)
      ).toBeVisible()
    }

    // Cursor is listed and explicitly NOT injected: Starbase has no run path for
    // it, and a green row there would promise tools to an agent that never starts.
    await expect(row(app.window, "Cursor").getByText("not injected")).toBeVisible()
    await expect(row(app.window, "Cursor").getByText(/does not launch/)).toBeVisible()

    // The bearer really travelled to the instance (the probe was authenticated).
    expect(instance.mcpAuthHeaders()).toContain(`Bearer ${FAKE_TOKEN}`)
  } finally {
    await instance.close()
  }
})

test("a missing token is reported as such, not as a disabled feature", async ({ launchApp }) => {
  const instance = await startFakeOpenConnector()
  try {
    const app = await launchApp({ configured: true })
    await openSettings(app.window)

    // Endpoint + enabled, but no token: the one case that used to look identical
    // to "switched off" while failing for an entirely different reason.
    await connect(app.window, instance.endpoint)

    await expect(row(app.window, "Claude Code").getByText(/No API token/)).toBeVisible()
    await expect(row(app.window, "Codex").getByText(/No API token/)).toBeVisible()

    // Supplying the token flips every harness without a restart.
    await app.window.getByPlaceholder("Paste the instance token").fill(FAKE_TOKEN)
    await app.window.getByRole("button", { name: "Save" }).click()
    for (const harness of RUNNABLE) {
      await expect(row(app.window, harness).getByText("injected", { exact: true })).toBeVisible()
    }
  } finally {
    await instance.close()
  }
})

test("opting one harness out leaves the others injected, and survives a restart", async ({
  launchApp
}) => {
  const instance = await startFakeOpenConnector()
  try {
    const app = await launchApp({ configured: true })
    await openSettings(app.window)
    await connect(app.window, instance.endpoint, { token: FAKE_TOKEN })
    await expect(row(app.window, "Codex").getByText("injected", { exact: true })).toBeVisible()

    // Withhold the shared server from Codex only.
    await app.window.getByRole("switch", { name: "Inject into Codex" }).click()
    await expect(row(app.window, "Codex").getByText(/Switched off/)).toBeVisible()
    await expect(row(app.window, "Claude Code").getByText("injected", { exact: true })).toBeVisible()
    await expect(row(app.window, "opencode").getByText("injected", { exact: true })).toBeVisible()

    // A per-harness opt-out is a persisted decision, not a UI mood: relaunch
    // against the same `~/starbase` and the app must resolve it the same way.
    const restarted = await launchApp({
      configured: true,
      home: app.home,
      reposDir: app.reposDir
    })
    await openSettings(restarted.window)
    await expect(row(restarted.window, "Codex").getByText(/Switched off/)).toBeVisible()
    await expect(
      row(restarted.window, "Claude Code").getByText("injected", { exact: true })
    ).toBeVisible()

    // …and switching it back on restores it, still without a restart.
    await restarted.window.getByRole("switch", { name: "Inject into Codex" }).click()
    await expect(row(restarted.window, "Codex").getByText("injected", { exact: true })).toBeVisible()
  } finally {
    await instance.close()
  }
})
