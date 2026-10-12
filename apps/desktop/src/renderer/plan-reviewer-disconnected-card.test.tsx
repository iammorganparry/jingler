// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { setPlanDisconnected } from "./plan-presence.js"
import { PlanReviewerDisconnectedCard } from "./plan-reviewer-disconnected-card.js"
import { rpc } from "./rpc-client.js"

vi.mock("./rpc-client.js", () => ({
  rpc: { agentPlannotatorRecoveryNeeded: vi.fn() }
}))

afterEach(() => {
  cleanup()
  setPlanDisconnected("c1", false)
  vi.clearAllMocks()
})

describe("PlanReviewerDisconnectedCard", () => {
  it("renders nothing until the chat is marked disconnected", () => {
    render(<PlanReviewerDisconnectedCard sessionId="s1" chatId="c1" onResume={vi.fn()} />)
    expect(screen.queryByText("Plan reviewer disconnected")).toBeNull()
    act(() => setPlanDisconnected("c1", true))
    expect(screen.getByText("Plan reviewer disconnected")).toBeTruthy()
  })

  it("Reopen re-checks recovery, resumes the review, and dismisses the card", async () => {
    vi.mocked(rpc.agentPlannotatorRecoveryNeeded).mockResolvedValue(true)
    const onResume = vi.fn()
    setPlanDisconnected("c1", true)
    render(<PlanReviewerDisconnectedCard sessionId="s1" chatId="c1" onResume={onResume} />)
    fireEvent.click(screen.getByRole("button", { name: "Reopen" }))
    await waitFor(() => expect(onResume).toHaveBeenCalledOnce())
    expect(rpc.agentPlannotatorRecoveryNeeded).toHaveBeenCalledWith("s1", "c1")
    expect(screen.queryByText("Plan reviewer disconnected")).toBeNull()
  })

  it("does not resume a review that was settled elsewhere", async () => {
    vi.mocked(rpc.agentPlannotatorRecoveryNeeded).mockResolvedValue(false)
    const onResume = vi.fn()
    setPlanDisconnected("c1", true)
    render(<PlanReviewerDisconnectedCard sessionId="s1" chatId="c1" onResume={onResume} />)
    fireEvent.click(screen.getByRole("button", { name: "Reopen" }))
    await waitFor(() => expect(screen.queryByText("Plan reviewer disconnected")).toBeNull())
    expect(onResume).not.toHaveBeenCalled()
  })
})
