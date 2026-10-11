import { expect, test } from "./fixtures.js"

test("Memory dashboard separates source conversion, citations, and durable relationships", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    config: { memory: { enabled: true, organizationId: "org-e2e" } }
  })

  await window.getByTestId("memory-sidebar-item").click()
  await expect(window.getByRole("heading", { name: "Memory overview" })).toBeVisible()
  await expect(window.getByRole("heading", { name: "Source conversion" })).toBeVisible()
  await expect(window.getByText("22000 durable page edges · 15000 source citations")).toBeVisible()
  await expect(window.getByRole("row", { name: /conversation 8 7 6 6 1 1 0/i })).toBeVisible()
  await expect(window.getByRole("columnheader", { name: "Delivery failures" })).toBeVisible()
  await expect(window.getByRole("columnheader", { name: "Compiler failures" })).toBeVisible()
  await expect(window.getByText("12 content-free transitions")).toBeVisible()
  await expect(window.getByText(/Source citations support claims/)).toBeVisible()
})
