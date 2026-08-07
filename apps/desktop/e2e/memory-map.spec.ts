import { expect, test } from "./fixtures.js"
import { startFakeAuthServer } from "./fake-auth.js"

const HEALTH_FINDINGS = /Health findings/
const FILTERED_GRAPH = /1\/10000 nodes/

test("Memory map restores explicit navigation state and clears it at an organization boundary", async ({ launchApp }) => {
  const fake = await startFakeAuthServer()
  try {
    const first = await launchApp({
      authServer: fake,
      configured: true,
      config: { memory: { enabled: true, organizationId: "org-e2e" } }
    })
    await first.window.emulateMedia({ reducedMotion: "reduce" })
    expect(await first.window.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true)

    await first.window.getByTestId("memory-sidebar-item").click()
    await expect(first.window.getByRole("heading", { name: "Memory overview" })).toBeVisible()
    await first.window.getByRole("button", { name: HEALTH_FINDINGS }).click()

    const canvas = first.window.getByTestId("memory-map-canvas")
    await expect(canvas).toBeVisible()
    await expect(first.window.getByText(FILTERED_GRAPH)).toBeVisible()
    await expect(first.window.getByRole("button", { name: "Findings" })).toHaveAttribute("aria-pressed", "true")
    await first.window.getByRole("button", { name: "Findings" }).click()

    // The synchronized list is the keyboard/screen-reader fallback for canvas.
    const alpha = first.window.getByTestId("memory-node-page:alpha")
    await alpha.focus()
    await first.window.keyboard.press("Enter")
    const inspector = first.window.getByTestId("memory-inspector")
    await expect(inspector).toContainText("page:alpha")
    await expect(inspector).toContainText("Citations (1)")
    await expect(inspector).toContainText("Revision 2")
    await expect(inspector).not.toContainText("proposals")
    await first.window.getByRole("button", { name: "Close inspector" }).click()

    const edge = first.window.getByTestId("memory-edge-edge:org-e2e:alpha-beta")
    await edge.focus()
    await first.window.keyboard.press("Enter")
    await expect(inspector).toContainText("Accepted relationship")
    await expect(inspector).toContainText("wikilink")
    await expect(inspector).toContainText("[[beta]]")
    await expect(inspector).toContainText("Inferred and embedding-derived relationships are not displayed")
    await first.window.getByRole("button", { name: "Close inspector" }).click()

    const filter = first.window.getByPlaceholder("Filter nodes")
    await filter.fill("Beta")
    await expect(first.window.getByTestId("memory-node-page:alpha")).toHaveCount(0)
    await expect(first.window.getByTestId("memory-node-page:beta")).toBeVisible()
    await filter.fill("")

    await first.window.getByTestId("memory-node-page:alpha").click()
    await expect(inspector).toBeVisible()
    await first.window.getByRole("button", { name: "Zoom in" }).click()
    await first.window.getByRole("button", { name: "Pan right" }).click()
    const restoredViewport = await canvas.getAttribute("data-viewport")
    expect(restoredViewport).not.toBe("0,0,1")

    await inspector.getByRole("button", { name: "Open page" }).click()
    const page = first.window.getByTestId("memory-page")
    await expect(page).toContainText("Alpha memory")
    await expect(page).toContainText("source-alpha")
    await page.getByRole("button", { name: "Back to previous view" }).click()
    await expect(canvas).toHaveAttribute("data-viewport", restoredViewport ?? "")
    await expect(first.window.getByTestId("memory-node-page:alpha")).toHaveAttribute("aria-pressed", "true")

    await first.app.close()

    // Reuse Chromium localStorage to make the boundary adversarial: the last map
    // subview survives, but graph ids, filters, viewport, and selection may not.
    const second = await launchApp({
      authServer: fake,
      configured: true,
      userDataDir: first.userDataDir,
      config: { memory: { enabled: true, organizationId: "org-other" } }
    })
    await second.window.getByTestId("memory-sidebar-item").click()
    const otherCanvas = second.window.getByTestId("memory-map-canvas")
    await expect(otherCanvas).toBeVisible()
    await expect(second.window.getByRole("combobox", { name: "Memory organization" })).toHaveValue("org-other")
    await expect(second.window.getByPlaceholder("Filter nodes")).toHaveValue("")
    await expect(otherCanvas).toHaveAttribute("data-viewport", "0,0,1")
    await expect(second.window.getByTestId("memory-inspector")).toHaveCount(0)
    await expect(second.window.getByTestId("memory-node-page:alpha")).toHaveCount(0)
    await expect(second.window.getByTestId("memory-node-page:other-alpha")).toBeVisible()
    await expect(second.window.getByText("Alpha memory", { exact: true })).toHaveCount(0)
  } finally {
    await fake.close()
  }
})
