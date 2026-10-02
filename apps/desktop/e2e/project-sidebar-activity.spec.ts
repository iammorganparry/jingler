import { appShell, expect, test } from "./fixtures.js"

test("projects show live activity and stay ordered after selection", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    isolateSystemHome: true,
    withRepo: true,
    sessions: ({ repoPath }) => [
      { id: "worker", repo: "widget", status: "running", updatedAt: "2026-08-07T12:00:00.000Z" },
      { id: "quiet", repo: "alpha", status: "idle", updatedAt: "2026-08-07T10:00:00.000Z" },
      { id: "quiet-two", repo: "alpha", status: "idle", updatedAt: "2026-08-07T09:00:00.000Z" }
    ].map((session) => ({
      ...session,
      status: session.id === "worker" ? "running" as const : "idle" as const,
      title: session.id,
      branch: "main",
      worktreePath: repoPath,
      ...(session.id === "worker" ? { repoPath } : {}),
      diff: { added: 0, removed: 0 },
      prNumber: null,
      costUsd: 0,
      tokens: 0,
      mode: "accept-edits" as const
    }))
  })
  await expect(appShell(window)).toBeVisible()
  await window.setViewportSize({ width: 1500, height: 860 })
  const projects = window.getByTestId("project-sidebar")
  const items = projects.locator('[data-testid^="project-row-"]')
  await expect(items).toHaveCount(2)
  await expect(items).toHaveText(["U2", "W1"])
  const order = await items.evaluateAll((rows) => rows.map((row) => row.getAttribute("data-testid")))
  await projects.getByRole("button", { name: "widget", exact: true }).click()
  await expect(window.getByRole("navigation", { name: "Breadcrumb" }).getByText("worker", { exact: true })).toBeVisible()
  const composer = window.getByPlaceholder("Message the agent…")
  await composer.fill("[[queue-hold]] keep this project busy")
  await composer.press("Enter")
  const activity = projects.getByRole("status", { name: "widget: sessions in progress" })
  await expect(activity).toBeVisible()
  await projects.getByRole("button", { name: "Unassigned", exact: true }).click()
  await expect(window.getByTestId("session-row-quiet")).toBeVisible()
  await expect(window.getByRole("navigation", { name: "Breadcrumb" }).getByText("quiet", { exact: true })).toBeVisible()
  await window.getByTestId("session-row-quiet-two").click()
  await expect(window.getByRole("navigation", { name: "Breadcrumb" }).getByText("quiet-two", { exact: true })).toBeVisible()
  await expect(window.getByTestId("session-row-worker")).toBeHidden()
  await expect(activity).toBeVisible()
  expect(await items.evaluateAll((rows) => rows.map((row) => row.getAttribute("data-testid")))).toEqual(order)
  await projects.getByRole("button", { name: "widget", exact: true }).click()
  await expect(window.getByTestId("session-row-worker")).toBeVisible()
  await expect(window.getByRole("navigation", { name: "Breadcrumb" }).getByText("worker", { exact: true })).toBeVisible()
  expect(await items.evaluateAll((rows) => rows.map((row) => row.getAttribute("data-testid")))).toEqual(order)
  await projects.getByRole("button", { name: "Unassigned", exact: true }).click()
  await expect(window.getByRole("navigation", { name: "Breadcrumb" }).getByText("quiet-two", { exact: true })).toBeVisible()
  expect(await items.evaluateAll((rows) => rows.map((row) => row.getAttribute("data-testid")))).toEqual(order)
})
