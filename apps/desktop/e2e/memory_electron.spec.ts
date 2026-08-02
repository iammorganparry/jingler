import { expect, test } from "./fixtures.js"

const HEALTH_FINDINGS = /Health findings/
const FILTERED_NODE_COUNT = /1\/10000 nodes/

test("eligible team members open bounded Memory views from the persistent sidebar", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true
  })

  await expect(window.getByTestId("memory-sidebar-item")).toBeVisible()
  await window.getByTestId("memory-sidebar-item").click()
  await expect(window.getByTestId("memory-workspace")).toBeVisible()
  await window.getByLabel("Memory organization").selectOption("org-e2e")
  await expect(window.getByRole("heading", { name: "Memory overview" })).toBeVisible()
  await expect(window.getByText("10000", { exact: true })).toBeVisible()

  // The time-range selector is wired end to end: it re-requests the dashboard
  // with the chosen window, and the worker scopes the retrieval series to it.
  // `Searches` (first metric in the retrieval panel) moves with the window while
  // `Accepted pages` (a current-state snapshot) stays put — the same split the
  // fake honours because the real analytics never windows current state.
  const searches = window.locator('section[aria-labelledby="memory-retrieval-title"] dd').first()
  await expect(searches).toHaveText("32") // default 30d window
  await window.getByLabel("Memory time range").selectOption("7d")
  await expect(searches).toHaveText("9")
  await expect(window.getByText("10000", { exact: true })).toBeVisible()
  await window.getByLabel("Memory time range").selectOption("all")
  await expect(searches).toHaveText("90")

  await window.getByRole("button", { name: HEALTH_FINDINGS }).click()
  await expect(window.getByTestId("memory-map-canvas")).toBeVisible()
  await expect(window.getByText(FILTERED_NODE_COUNT)).toBeVisible()
  await window.getByTestId("memory-node-page:alpha").click()
  await expect(window.getByTestId("memory-inspector")).toContainText("page:alpha")
})
