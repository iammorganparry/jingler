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

test("a blocked session shows an amber needs-you count on its project tile until answered", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    isolateSystemHome: true,
    withRepo: true,
    sessions: ({ repoPath }) => [
      { id: "asker", repoPath, updatedAt: "2026-08-07T12:00:00.000Z" },
      { id: "quiet", updatedAt: "2026-08-07T10:00:00.000Z" }
    ].map((session) => ({
      ...session,
      repo: session.id === "asker" ? "widget" : "alpha",
      status: "idle" as const,
      title: session.id,
      branch: "main",
      worktreePath: repoPath,
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
  const badge = projects.locator('[data-testid^="project-needs-you-"]')
  await projects.getByRole("button", { name: "widget", exact: true }).click()
  const composer = window.getByPlaceholder("Message the agent…")
  await composer.fill("[[ask]] migrate the store")
  await composer.press("Enter")
  await expect(window.getByText("Agent needs your input")).toBeVisible({ timeout: 15_000 })

  // Viewing another project, the blocked one's tile still carries the one-line amber count.
  await projects.getByRole("button", { name: "Unassigned", exact: true }).click()
  await expect(badge).toHaveText("1")
  await expect(badge).toHaveAccessibleName("widget: 1 needs you")
  expect(await badge.locator("span").first().evaluate((el) => getComputedStyle(el).whiteSpace)).toBe("nowrap")

  // Answering clears it without a reload.
  await projects.getByRole("button", { name: "widget", exact: true }).click()
  await expect(window.getByText("Agent needs your input")).toBeVisible()
  await window.keyboard.press("2")
  await window.keyboard.press("Enter")
  await window.keyboard.press("1")
  await window.keyboard.press("Enter")
  await expect(badge).toHaveCount(0, { timeout: 15_000 })
})
