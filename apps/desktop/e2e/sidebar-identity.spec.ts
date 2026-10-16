import { execFileSync } from "node:child_process"
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
    providerId: "anthropic",
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
    repo: "jingler",
    branch: "chore/quiet",
    title: "Quiet maintenance",
    status: "idle",
    providerId: "openrouter",
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
    providerId: "openai-codex",
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
  const { window } = await launchApp({
    configured: true,
    isolateSystemHome: true,
    withRepo: true,
    seed: ({ repoPath }) => {
      execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/widget.git"], {
        cwd: repoPath
      })
    },
    sessions: ({ repoPath }) =>
      sessions.map((session) =>
        session.id === "s_running"
          // `repoPath` is what projects are backfilled from; a real session
          // always records it alongside its worktree.
          ? { ...session, repo: "widget", repoPath, worktreePath: repoPath }
          : session
      )
  })
  await expect(appShell(window)).toBeVisible()

  const attention = window.locator('[data-testid="session-row-s_attention"]').last()
  const running = window.locator('[data-testid="session-row-s_running"]').last()
  const idle = window.locator('[data-testid="session-row-s_idle"]').last()
  await expect(window.getByTestId("project-sidebar")).toBeVisible()
  await expect(running).toBeVisible()
  await expect(idle).toHaveCount(0)
  await expect(attention).toHaveCount(0)

  await window.getByRole("button", { name: "Unassigned", exact: true }).click()
  await expect(attention).toBeVisible()
  await expect(idle).toBeVisible()
  await expect(running).toHaveCount(0)
  const positions = await Promise.all([attention, idle].map((row) => row.boundingBox()))
  expect(positions[0]!.y).toBeLessThan(positions[1]!.y)
  await expect(window.getByText("Needs Input", { exact: true }).first()).toBeVisible()

  await expect(attention).toContainText("jingler")
  await expect(attention).toContainText("#5501")
  await expect(window.getByTestId("session-location-s_attention")).toHaveAttribute(
    "title",
    "Cloud session"
  )
  await expect(attention.getByTitle("OpenAI")).toBeVisible()

  await window.getByRole("button", { name: "widget", exact: true }).click()
  await expect(running).toBeVisible()
  await expect(window.getByTestId("session-location-s_running")).toHaveAttribute(
    "title",
    "Local session"
  )
  await expect(running.getByTitle("Repository: widget")).toHaveAttribute("data-repo-owner", "acme")

  const [appBackground, titleBarBackground] = await Promise.all([
    window.getByTestId("app-background").evaluate((element) => getComputedStyle(element).backgroundColor),
    window.getByTestId("title-bar").evaluate((element) => getComputedStyle(element).backgroundColor)
  ])
  expect(appBackground).toBe(titleBarBackground)

  await running.click()
  await expect(window.getByRole("navigation", { name: "Breadcrumb" }))
    .toContainText("Liquid glass sidebar")

  const sidebarSurface = await window.getByTestId("session-sidebar").evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      radius: Number.parseFloat(style.borderRadius),
      backdrop: style.backdropFilter,
      background: style.backgroundColor
    }
  })
  expect(sidebarSurface.radius).toBe(0)
  expect(sidebarSurface.backdrop).toBe("none")
  expect(sidebarSurface.background).toBe(appBackground)
  await expect(window.getByTestId("project-sidebar")).toHaveCSS(
    "background-color",
    sidebarSurface.background
  )
  await expect(window.getByRole("separator", { name: "Resize sidebar" })).toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)"
  )

  await window.getByRole("button", { name: "Collapse sidebar" }).click()
  const rail = window.getByTestId("session-rail")
  const railSurface = await rail.evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      radius: Number.parseFloat(style.borderRadius),
      backdrop: style.backdropFilter,
      background: style.backgroundColor
    }
  })
  expect(railSurface.radius).toBe(0)
  expect(railSurface.backdrop).toBe("none")
  expect(railSurface.background).toBe("rgba(0, 0, 0, 0)")
})

test("the rail's hover card lists every PR in a stacked session, bottom of the stack first", async ({
  launchApp
}) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    sessions: ({ repoPath }) => [
      {
        id: "s_stack",
        repo: "widget",
        branch: "stack/ui",
        title: "Stack session",
        status: "idle",
        diff: { added: 0, removed: 0 },
        prNumber: 482,
        prs: [
          { number: 480, branch: "stack/model", base: "main" },
          { number: 481, branch: "stack/api", base: "stack/model" },
          { number: 482, branch: "stack/ui", base: "stack/api" }
        ],
        costUsd: 0,
        tokens: 0,
        updatedAt: at(5),
        worktreePath: repoPath
      }
    ]
  })
  await expect(appShell(window)).toBeVisible()

  // Below the rail breakpoint, the sidebar collapses to the 52px rail and
  // each session's detail moves into its hover card.
  await window.setViewportSize({ width: 900, height: 700 })
  await window.waitForTimeout(120)
  await expect(window.getByTestId("session-rail")).toBeVisible()

  await window.locator('[data-session-id="s_stack"]').hover()
  const card = window.getByRole("tooltip")
  const stack = card.getByTestId("hover-card-pr-stack")
  await expect(stack).toBeVisible()
  await expect(card.getByTestId("hover-card-pr-stack-row-480")).toContainText("#480")
  await expect(card.getByTestId("hover-card-pr-stack-row-481")).toContainText("#481")
  await expect(card.getByTestId("hover-card-pr-stack-row-482")).toContainText("#482")
  await expect(stack.locator("> *")).toHaveCount(3)
})
