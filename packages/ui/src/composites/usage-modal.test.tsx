import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import type { UsageReport } from "@jingler/core"
import { makeUsageFact, usageReportFromFacts } from "@jingler/core"
import { afterEach, describe, expect, it } from "vitest"
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
