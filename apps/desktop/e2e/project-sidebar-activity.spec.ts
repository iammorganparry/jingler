import { appShell, expect, test } from "./fixtures.js"

test("project headings show activity and stay ordered after selection and collapse", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    isolateSystemHome: true,
    withRepo: true,
    sessions: ({ repoPath }) => [
      { id: "worker", repo: "widget", status: "running", updatedAt: "2026-08-07T12:00:00.000Z" },
      { id: "quiet", repo: "alpha", status: "idle", updatedAt: "2026-08-07T10:00:00.000Z" }
    ].map((session) => ({
      ...session,
      status: session.id === "worker" ? "running" as const : "idle" as const,
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
  await window.getByRole("button", { name: "Filter and sort sessions" }).click()
  await window.getByRole("menuitem", { name: /^Group by/ }).hover()
  await window.getByRole("menuitem", { name: "Repository", exact: true }).click()

  const headings = window.getByRole("button", { name: /^(Expand|Collapse) repository$/ })
  await expect(headings).toHaveText(["alpha", "widget"])
  await window.getByTestId("session-row-worker").click()
  const composer = window.getByPlaceholder("Message the agent…")
  await composer.fill("[[queue-hold]] keep this project busy")
  await composer.press("Enter")
  const activity = window.getByRole("status", { name: "widget: sessions in progress" })
  await expect(activity).toBeVisible()
  await expect(window.getByRole("status", { name: "alpha: sessions in progress" })).toHaveCount(0)
  await window.getByTestId("session-row-quiet").click()
  await expect(headings).toHaveText(["alpha", "widget"])
  await headings.filter({ hasText: "widget" }).click()
  await expect(window.getByTestId("session-row-worker")).toBeHidden()
  await expect(activity).toBeVisible()
  await expect(headings).toHaveText(["alpha", "widget"])
})
