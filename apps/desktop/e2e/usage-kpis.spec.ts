import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { appShell, expect, test } from "./fixtures.js"

/** A terminal accounting fact; `costUsd: null` means the provider reported no price. */
const fact = (id: string, costUsd: number | null) => ({
  id,
  runId: id,
  sessionId: "s_usage",
  chatId: "c_usage",
  parentRunId: null,
  runtimeId: "claude",
  providerId: "anthropic",
  modelId: "sonnet",
  kind: "parent",
  startedAt: "2026-07-11T00:00:00.000Z",
  endedAt: "2026-07-11T00:00:10.000Z",
  durationMs: 10_000,
  inputTokens: 1000,
  outputTokens: 500,
  cacheReadTokens: 250,
  cacheWriteTokens: 0,
  reasoningTokens: 250,
  totalTokens: 2000,
  costUsd,
  toolCalls: 3,
  outcome: "success",
  provenance: "e2e"
})

test("the usage modal shows KPI tiles with cost marked partial on the label line", async ({ launchApp }) => {
  const { window } = await launchApp({
    configured: true,
    withRepo: true,
    seed: ({ home }) => {
      const journals = join(home, "jingler", "runtime", "journals")
      mkdirSync(journals, { recursive: true })
      // One priced run and one unpriced run: cost coverage is 50%.
      writeFileSync(join(journals, "usage-facts.json"), JSON.stringify([fact("a", 1.5), fact("b", null)]))
    }
  })
  await expect(appShell(window)).toBeVisible()

  await window.getByRole("button", { name: "Account menu" }).click()
  await window.getByRole("menuitem", { name: /Usage & limits/ }).click()

  const kpis = window.getByTestId("usage-kpis")
  await expect(kpis).toBeVisible()
  for (const label of ["Runs", "Success rate", "Tokens", "Known cost"]) {
    await expect(kpis.getByTestId("kpi-label").filter({ hasText: label })).toBeVisible()
  }
  // The partial marker shares the cost tile's label line.
  await expect(kpis.getByTestId("kpi-label").filter({ hasText: "Known cost" }).getByText("partial")).toBeVisible()
  await expect(kpis.getByText("cost known for 50% of runs")).toBeVisible()
  await expect(kpis.getByRole("img", { name: /Tokens: input, output, cache, reasoning/ })).toBeVisible()
})
