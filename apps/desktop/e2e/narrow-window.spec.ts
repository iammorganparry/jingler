import { expect, test } from "./fixtures.js"

test("at 760px the sidebar is a rail, New session fits the viewport, and the sidebar expands", async ({ launchApp }) => {
  const { window } = await launchApp({ configured: true, withRepo: true })
  await window.setViewportSize({ width: 760, height: 700 })
  await window.waitForTimeout(120)

  await expect(window.getByTestId("session-rail")).toBeVisible()

  await window.getByRole("button", { name: "New session", exact: true }).first().click()
  const view = window.getByTestId("new-session-view")
  await expect(view).toBeVisible()
  const inside = async (testId: string) => {
    const box = await window.getByTestId(testId).boundingBox()
    expect(box).toBeTruthy()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(760 + 1)
  }
  await inside("new-session-view")
  await inside("new-workspace-chip-row")
  await expect(view.getByRole("textbox").first()).toBeVisible()
  const composer = await view.getByRole("textbox").first().boundingBox()
  expect(composer!.x + composer!.width).toBeLessThanOrEqual(760 + 1)

  await window.getByRole("button", { name: "Expand sidebar" }).click()
  await expect(window.getByTestId("session-sidebar")).toBeVisible()
})
