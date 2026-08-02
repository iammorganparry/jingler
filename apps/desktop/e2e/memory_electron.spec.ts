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

  await window.getByRole("button", { name: HEALTH_FINDINGS }).click()
  await expect(window.getByTestId("memory-map-canvas")).toBeVisible()
  await expect(window.getByText(FILTERED_NODE_COUNT)).toBeVisible()
  await window.getByTestId("memory-node-page:alpha").click()
  await expect(window.getByTestId("memory-inspector")).toContainText("page:alpha")
})
