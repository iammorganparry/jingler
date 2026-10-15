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
