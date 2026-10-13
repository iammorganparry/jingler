import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { formatElapsed, SubagentChip, type SubagentChipItem } from "./subagent-chip.js"

afterEach(cleanup)

const item = (over: Partial<SubagentChipItem> & { id: string }): SubagentChipItem => ({
  agent: "worker",
  task: `Task ${over.id}`,
  status: "running",
  startedAt: 0,
  ...over
})

const openChip = () => fireEvent.pointerDown(screen.getByTestId("subagent-chip"), { button: 0, ctrlKey: false })

describe("SubagentChip", () => {
  it("renders nothing when there are no subagents", () => {
    render(<SubagentChip subagents={[]} onOpenSubagent={vi.fn()} />)
    expect(screen.queryByTestId("subagent-chip")).toBeNull()
  })

  it("counts running subagents in the chip label", () => {
    render(
      <SubagentChip
        subagents={[item({ id: "a" }), item({ id: "b", status: "spawning" }), item({ id: "c", status: "completed", endedAt: 5000 })]}
        onOpenSubagent={vi.fn()}
      />
    )
    expect(screen.getByTestId("subagent-chip").textContent).toContain("2 subagents")
  })

  it("lists running rows then a Finished section with elapsed time", () => {
    render(
      <SubagentChip
        subagents={[
          item({ id: "a", agent: "reviewer", task: "Review the diff", startedAt: Date.now() - 65_000 }),
          item({ id: "b", status: "failed", startedAt: 0, endedAt: 12_000 })
        ]}
        onOpenSubagent={vi.fn()}
      />
    )
    openChip()
    const running = screen.getByTestId("subagent-chip-row-a")
    expect(running.textContent).toContain("running")
    expect(running.textContent).toContain("reviewer")
    expect(running.textContent).toContain("Review the diff")
    expect(running.textContent).toContain("1m 5s")
    expect(screen.getByText("Finished · 1")).toBeTruthy()
    const failed = screen.getByTestId("subagent-chip-row-b")
    expect(failed.textContent).toContain("failed")
    expect(failed.textContent).toContain("12s")
  })

  it("opens the clicked subagent", () => {
    const onOpenSubagent = vi.fn()
    render(<SubagentChip subagents={[item({ id: "a" }), item({ id: "b" })]} onOpenSubagent={onOpenSubagent} />)
    openChip()
    fireEvent.click(screen.getByTestId("subagent-chip-row-b"))
    expect(onOpenSubagent).toHaveBeenCalledWith("b")
  })

  it("collapses rows past the cap into +N more", () => {
    const many = Array.from({ length: 10 }, (_, index) => item({ id: `w${index}` }))
    render(<SubagentChip subagents={many} onOpenSubagent={vi.fn()} />)
    openChip()
    expect(screen.getByText("+2 more")).toBeTruthy()
    expect(screen.queryByTestId("subagent-chip-row-w9")).toBeNull()
  })
})

describe("formatElapsed", () => {
  it("formats seconds, minutes and hours", () => {
    expect(formatElapsed(900)).toBe("0s")
    expect(formatElapsed(65_000)).toBe("1m 5s")
    expect(formatElapsed(3_660_000)).toBe("1h 1m")
  })
})
