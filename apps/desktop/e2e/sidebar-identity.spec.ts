import { appShell, expect, test } from "./fixtures.js"
import type { SeedSession } from "./fixtures.js"

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString()

const sessions: ReadonlyArray<SeedSession> = [
  {
    id: "s_running",
    repo: "jingler",
    branch: "feat/sidebar-glass",
    title: "Liquid glass sidebar",
    status: "running",
    cli: "claude",
    executionLocation: "local",
    diff: { added: 18, removed: 4 },
    prNumber: 5462,
    costUsd: 0,
    tokens: 0,
    updatedAt: at(13),
    mode: "accept-edits"
  },
  {
    id: "s_idle",
    repo: "widget",
    branch: "chore/quiet",
    title: "Quiet maintenance",
    status: "idle",
    cli: "opencode",
    executionLocation: "local",
    diff: { added: 0, removed: 0 },
    prNumber: null,
    costUsd: 0,
    tokens: 0,
    updatedAt: at(1),
    mode: "accept-edits"
  },
  {
    id: "s_attention",
    repo: "jingler",
    branch: "feat/cloud-session",
    title: "Cloud session approval",
    status: "needs-input",
    cli: "codex",
    executionLocation: "cloud",
    diff: { added: 3, removed: 1 },
    prNumber: 5501,
    costUsd: 0,
    tokens: 0,
    updatedAt: at(30),
    mode: "accept-edits"
  }
]

test("sidebar prioritises attention and exposes session identity at a glance", async ({
  launchApp
}) => {
  const { window } = await launchApp({ configured: true, sessions })
  await expect(appShell(window)).toBeVisible()

  const attention = window.locator('[data-testid="session-row-s_attention"]').last()
  const running = window.locator('[data-testid="session-row-s_running"]').last()
  const idle = window.locator('[data-testid="session-row-s_idle"]').last()
  await expect(attention).toBeVisible()
  await expect(running).toBeVisible()
  await expect(idle).toBeVisible()
  const positions = await Promise.all([attention, running, idle].map((row) => row.boundingBox()))
  expect(positions[0]!.y).toBeLessThan(positions[1]!.y)
  expect(positions[0]!.y).toBeLessThan(positions[2]!.y)

  await expect(attention).toContainText("jingler")
  await expect(attention).toContainText("Needs Input")
  await expect(attention).toContainText("#5501")
  await expect(window.getByTestId("session-location-s_attention")).toHaveAttribute(
    "title",
    "Cloud session"
  )
  await expect(attention.getByTitle("Codex harness")).toBeVisible()

  await expect(window.getByTestId("session-location-s_running")).toHaveAttribute(
    "title",
    "Local session"
  )

  await running.click()
  await expect(window.getByTestId("conversation-tab")).toHaveAttribute(
    "title",
    /jingler \/ Liquid glass sidebar/
  )

  const glass = await window.getByTestId("session-sidebar").evaluate((element) => {
    const style = getComputedStyle(element)
    return { radius: Number.parseFloat(style.borderRadius), backdrop: style.backdropFilter }
  })
  expect(glass.radius).toBeGreaterThan(0)
  expect(glass.backdrop).toContain("blur")
})
