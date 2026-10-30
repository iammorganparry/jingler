import { appShell, expect, test } from "./fixtures.js"

test("every workspace row stays visible and selectable while another is running", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    isolateSystemHome: true,
    withRepo: true,
    sessions: ({ repoPath }) => [
      { id: "worker", repo: "widget", updatedAt: "2026-08-07T12:00:00.000Z" },
      { id: "quiet", repo: "alpha", updatedAt: "2026-08-07T10:00:00.000Z" },
      { id: "quiet-two", repo: "alpha", updatedAt: "2026-08-07T09:00:00.000Z" }
    ].map((session) => ({
      ...session,
      status: "idle" as const,
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
  const identity = (title: string) => window.getByTestId("session-header-identity").getByText(title, { exact: true })
  for (const id of ["worker", "quiet", "quiet-two"]) await expect(window.getByTestId(`session-row-${id}`)).toBeVisible()
  await window.getByTestId("session-row-worker").click()
  await expect(identity("worker")).toBeVisible()
  const composer = window.getByPlaceholder("Message the agent…")
  await composer.fill("[[queue-hold]] keep this workspace busy")
  await composer.press("Enter")
  await window.getByTestId("session-row-quiet").click()
  await expect(identity("quiet")).toBeVisible()
  await window.getByTestId("session-row-quiet-two").click()
  await expect(identity("quiet-two")).toBeVisible()
  for (const id of ["worker", "quiet", "quiet-two"]) await expect(window.getByTestId(`session-row-${id}`)).toBeVisible()
  await window.getByTestId("session-row-worker").click()
  await expect(identity("worker")).toBeVisible()
})

test("a blocked session shows a needs-input state on its row until answered", async ({ launchApp }) => {
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
  const asker = window.getByTestId("session-row-asker")
  await window.getByTestId("session-row-asker").click()
  const composer = window.getByPlaceholder("Message the agent…")
  await composer.fill("[[ask]] migrate the store")
  await composer.press("Enter")
  await expect(window.getByText("Agent needs your input")).toBeVisible({ timeout: 15_000 })

  // Viewing another workspace, the blocked one's row still carries the one-line amber count.
  await window.getByTestId("session-row-quiet").click()
  await expect(asker).toContainText("Needs Input")

  // Answering clears it without a reload.
  await window.getByTestId("session-row-asker").click()
  await expect(window.getByText("Agent needs your input")).toBeVisible()
  await window.keyboard.press("2")
  await window.keyboard.press("Enter")
  await window.keyboard.press("1")
  await window.keyboard.press("Enter")
  await expect(asker).not.toContainText("Needs Input", { timeout: 15_000 })
})
