import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import type { UsageReport } from "@jingler/core"
import { makeUsageFact, usageReportFromFacts } from "@jingler/core"
import { afterEach, describe, expect, it } from "vitest"
import type { Usage } from "@jingler/core"
import { UsageModal } from "./usage-modal.js"

afterEach(cleanup)

const report: UsageReport = usageReportFromFacts([
  makeUsageFact({
    id: "a", runId: "a", sessionId: "s", chatId: "c", parentRunId: null,
    runtimeId: "claude", providerId: "anthropic", modelId: "claude-sonnet", kind: "parent",
    startedAt: Date.now(), outcome: "success", provenance: "test",
    inputTokens: 100, outputTokens: 20, totalTokens: 120, costUsd: 0.5, toolCalls: 1
  }),
  makeUsageFact({
    id: "b", runId: "b", sessionId: "s", chatId: "c", parentRunId: null,
    runtimeId: "codex", providerId: "openai", modelId: "gpt-codex", kind: "parent",
    startedAt: Date.now(), outcome: "success", provenance: "test",
    inputTokens: 10, outputTokens: 5, totalTokens: 15, toolCalls: 2
  })
])

describe("UsageModal execution report", () => {
  it("updates the KPIs and model table when the runtime filter changes", () => {
    render(<UsageModal open usage={null} report={report} />)

    const table = screen.getByTestId("model-performance-table")
    expect(within(table).getAllByTestId("model-performance-row")).toHaveLength(2)
    expect(screen.getByTestId("usage-kpis").textContent).toContain("2")

    fireEvent.click(screen.getByRole("radio", { name: "Claude" }))

    const filteredTable = screen.getByTestId("model-performance-table")
    const rows = within(filteredTable).getAllByTestId("model-performance-row")
    expect(rows).toHaveLength(1)
    expect(rows[0]!.textContent).toContain("claude-sonnet")
    expect(screen.getByTestId("usage-kpis").textContent).toContain("1")
  })

  it("drops facts older than the selected date range from the KPIs and table", () => {
    const old = makeUsageFact({
      id: "o", runId: "o", sessionId: "s", chatId: "c", parentRunId: null,
      runtimeId: "pi", providerId: "openai", modelId: "pi-old", kind: "parent",
      startedAt: Date.now() - 60 * 86_400_000, outcome: "success", provenance: "test",
      inputTokens: 1, outputTokens: 1, totalTokens: 2, toolCalls: 0
    })
    render(<UsageModal open usage={null} report={usageReportFromFacts([...report.facts, old])} />)
    expect(screen.getAllByTestId("model-performance-row")).toHaveLength(3)

    fireEvent.click(screen.getByRole("radio", { name: "30 days" }))

    const rows = screen.getAllByTestId("model-performance-row")
    expect(rows).toHaveLength(2)
    expect(rows.some((r) => r.textContent?.includes("pi-old"))).toBe(false)
  })

  it("re-sorts the model table when a column header is clicked", () => {
    render(<UsageModal open usage={null} report={report} />)
    const table = screen.getByTestId("model-performance-table")
    expect(within(table).getAllByTestId("model-performance-row").map((r) => r.textContent?.slice(0, 20)))
      .toEqual(expect.arrayContaining([expect.stringContaining("claude-sonnet"), expect.stringContaining("gpt-codex")]))

    fireEvent.click(screen.getByRole("button", { name: /Tokens/ }))
    const sortedDesc = within(screen.getByTestId("model-performance-table")).getAllByTestId("model-performance-row")
    expect(sortedDesc[0]!.textContent).toContain("claude-sonnet")

    fireEvent.click(screen.getByRole("button", { name: /Tokens/ }))
    const sortedAsc = within(screen.getByTestId("model-performance-table")).getAllByTestId("model-performance-row")
    expect(sortedAsc[0]!.textContent).toContain("gpt-codex")
  })
})

const apiUsage = {
  fetchedAt: "2026-10-13T12:00:00.000Z",
  providers: [{
    name: "Claude",
    plan: "Enterprise · API pricing",
    available: true,
    billingRoute: "api",
    windows: [],
    spend: {
      lastSession: { tokens: 12_500, costUsd: 1.234 },
      today: { tokens: 2_000_000, costUsd: 4.5 },
      month: { tokens: 0, costUsd: 0 }
    }
  }]
} as unknown as Usage

describe("UsageModal", () => {
  it("shows spend with the API-pricing plan label and no percentage bars for an API-priced connection", () => {
    render(<UsageModal open usage={apiUsage} />)
    expect(screen.getByText("Enterprise · API pricing")).toBeTruthy()
    expect(screen.getByText("$1.23 · 13k tokens")).toBeTruthy()
    expect(screen.getByText("$4.50 · 2.0M tokens")).toBeTruthy()
    expect(screen.queryByText(/% used/)).toBeNull()
    expect(screen.queryByText(/isn't available/)).toBeNull()
  })
})
