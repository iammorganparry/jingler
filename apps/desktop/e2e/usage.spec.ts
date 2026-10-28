import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { appShell, expect, test } from "./fixtures.js"

/** The CLI's own rate-limit report: the five-hour window is exhausted, the weekly one is not. */
const rateLimitEvent = (resetsAt: number) =>
  JSON.stringify({
    type: "rate_limit_event",
    rate_limit_info: {
      status: "rejected",
      unifiedWindows: {
        five_hour: { utilization: 1, resetsAt },
        seven_day: { utilization: 0.4, resetsAt }
      }
    }
  })

test("the account menu shows a limited provider's reset time without status colours", async ({ launchApp }) => {
  const resetsAt = Math.floor(Date.now() / 1000) + 3600
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    piFixture: { scenarioId: "usage-popover", authRoute: "claude-setup-token" },
    e2eEnv: { JINGLER_E2E_CLAUDE_RATE_LIMITS: rateLimitEvent(resetsAt) }
  })
  await expect(appShell(window)).toBeVisible()

  await window.getByRole("button", { name: "Account menu" }).click()

  const limits = window.getByTestId("usage-limits")
  const limited = limits.getByTestId("usage-limit-row").filter({ hasText: "Current session" })
  await expect(limited).toContainText(/Limited until \S+/)
  await expect(limited).toHaveAttribute("data-limited", "true")
  await expect(limits.getByTestId("usage-limit-row").filter({ hasText: "Weekly" })).toContainText("40% used")
  await expect(limits.getByTestId("usage-relay-quota")).toContainText("placeholder")

  // Neutral rows: the limited row carries the same text colour as an ok row.
  const colour = (row: typeof limited) => row.locator("span").last().evaluate((el) => getComputedStyle(el).color)
  expect(await colour(limited)).toBe(await colour(limits.getByTestId("usage-limit-row").filter({ hasText: "Weekly" })))

  // The Settings → Usage entry point stays in the same menu.
  await expect(window.getByRole("menuitem", { name: /Usage & limits/ })).toBeVisible()
})

/** A terminal accounting fact; `costUsd: null` means the provider reported no price. */
const fact = (id: string, runtimeId: string, modelId: string) => ({
  id,
  runId: id,
  sessionId: "s_usage",
  chatId: "c_usage",
  parentRunId: null,
  runtimeId,
  providerId: runtimeId === "claude" ? "anthropic" : "openai",
  modelId,
  kind: "parent",
  startedAt: "2026-07-11T00:00:00.000Z",
  endedAt: "2026-07-11T00:00:10.000Z",
  durationMs: 10_000,
  inputTokens: 1000,
  outputTokens: 500,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  totalTokens: 1500,
  costUsd: 1,
  toolCalls: 1,
  outcome: "success",
  provenance: "e2e"
})

test("changing the runtime filter updates the execution report's KPIs and model table", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    seed: ({ home }) => {
      const journals = join(home, "jingler", "runtime", "journals")
      mkdirSync(journals, { recursive: true })
      writeFileSync(
        join(journals, "usage-facts.json"),
        JSON.stringify([fact("a", "claude", "sonnet"), fact("b", "codex", "gpt-codex")])
      )
    }
  })
  await expect(appShell(window)).toBeVisible()

  await window.getByRole("button", { name: "Account menu" }).click()
  await window.getByRole("menuitem", { name: /Usage & limits/ }).click()

  const table = window.getByTestId("model-performance-table")
  await expect(table.getByTestId("model-performance-row")).toHaveCount(2)
  await expect(window.getByTestId("usage-kpis").getByText("2", { exact: true })).toBeVisible()

  await window.getByRole("radio", { name: "Claude" }).click()

  await expect(table.getByTestId("model-performance-row")).toHaveCount(1)
  await expect(table.getByTestId("model-performance-row")).toContainText("sonnet")
  await expect(window.getByTestId("usage-kpis").getByText("1", { exact: true })).toBeVisible()
})

test("clicking a model row opens its detail drawer; Esc closes it", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    seed: ({ home }) => {
      const journals = join(home, "jingler", "runtime", "journals")
      mkdirSync(journals, { recursive: true })
      writeFileSync(
        join(journals, "usage-facts.json"),
        JSON.stringify([fact("a", "claude", "sonnet"), fact("b", "codex", "gpt-codex")])
      )
    }
  })
  await expect(appShell(window)).toBeVisible()

  await window.getByRole("button", { name: "Account menu" }).click()
  await window.getByRole("menuitem", { name: /Usage & limits/ }).click()

  const table = window.getByTestId("model-performance-table")
  await table.getByTestId("model-performance-row").filter({ hasText: "sonnet" }).click()

  const drawer = window.getByTestId("model-detail-drawer")
  await expect(drawer).toBeVisible()
  await expect(drawer).toContainText("sonnet")
  await expect(drawer.getByTestId("model-detail-slowest-runs")).toBeVisible()

  await window.keyboard.press("Escape")
  await expect(drawer).toBeHidden()
})

test("at 1100px the date-range filter updates KPIs, columns sort, and route badges stay on one line", async ({ launchApp }) => {
  const { app, window } = await launchApp({
    configured: true,
    withRepo: true,
    piFixture: { scenarioId: "usage-popover", authRoute: "claude-setup-token" },
    seed: ({ home }) => {
      const journals = join(home, "jingler", "runtime", "journals")
      mkdirSync(journals, { recursive: true })
      const old = { ...fact("c", "pi", "pi-old"), startedAt: "2020-01-01T00:00:00.000Z", endedAt: "2020-01-01T00:00:10.000Z" }
      const recent = (id: string, runtime: string, model: string, tokens: number) => ({
        ...fact(id, runtime, model),
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        totalTokens: tokens
      })
      writeFileSync(
        join(journals, "usage-facts.json"),
        JSON.stringify([recent("a", "claude", "sonnet", 1500), recent("b", "codex", "gpt-codex", 90_000), old])
      )
    }
  })
  await expect(appShell(window)).toBeVisible()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1100, 900))

  await window.getByRole("button", { name: "Account menu" }).click()
  await window.getByRole("menuitem", { name: /Usage & limits/ }).click()

  const rows = window.getByTestId("model-performance-row")
  await expect(rows).toHaveCount(3)
  await window.getByRole("radio", { name: "30 days" }).click()
  await expect(rows).toHaveCount(2)
  await expect(window.getByTestId("usage-kpis").getByText("2", { exact: true })).toBeVisible()

  const table = window.getByTestId("model-performance-table")
  await table.getByRole("button", { name: /Tokens/ }).click()
  await expect(rows.first()).toContainText("gpt-codex")
  await table.getByRole("button", { name: /Tokens/ }).click()
  await expect(rows.first()).toContainText("sonnet")

  const boxes = await window.getByTestId("usage-route-badges").locator("> *").evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect()
      return { top: Math.round(r.top), height: Math.round(r.height) }
    })
  )
  expect(boxes.length).toBeGreaterThan(1)
  expect(new Set(boxes.map((b) => b.top)).size).toBe(1)
  expect(new Set(boxes.map((b) => b.height)).size).toBe(1)
})
