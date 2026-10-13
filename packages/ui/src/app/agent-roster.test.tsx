// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { PeerAgentRow } from "./agent-roster.js"

afterEach(cleanup)

const [, agentB] = [
  { chatId: "a", title: "Agent A", status: "running" as const, task: "Plan A", planStage: "Stage A", touchedFiles: ["src/a.ts"], updatedAt: "now" },
  { chatId: "b", title: "Agent B", status: "needs-input" as const, task: "Plan B", planStage: null, touchedFiles: ["src/shared.ts"], updatedAt: "now" }
]

describe("PeerAgentRow", () => {
  it("prevents duplicate sends and reports a rejected delivery", async () => {
    const onMessage = vi.fn(async () => {
      throw new Error("offline")
    })
    render(<PeerAgentRow agent={agentB!} onMessage={onMessage} />)
    fireEvent.click(screen.getByRole("button", { name: "Message Agent B" }))
    fireEvent.change(screen.getByRole("textbox", { name: "Message to Agent B" }), {
      target: { value: "hello" }
    })
    const send = screen.getByRole("button", { name: "Send" })
    fireEvent.click(send)
    fireEvent.click(send)

    await waitFor(() => expect(screen.getByText(/Not delivered/)).toBeTruthy())
    expect(screen.getByText(/Retry/)).toBeTruthy()
    expect(onMessage).toHaveBeenCalledOnce()
  })

  it("Retry resends the undelivered message to the same peer", async () => {
    const onMessage = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ status: "delivered" as const, targetChatId: "b" })
    render(<PeerAgentRow agent={agentB!} onMessage={onMessage} />)
    fireEvent.click(screen.getByRole("button", { name: "Message Agent B" }))
    fireEvent.change(screen.getByRole("textbox", { name: "Message to Agent B" }), { target: { value: "hello" } })
    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }))
    await waitFor(() => expect(onMessage).toHaveBeenCalledTimes(2))
    expect(onMessage).toHaveBeenLastCalledWith("b", "hello")
    await waitFor(() => expect(screen.queryByText(/Not delivered/)).toBeNull())
  })

  it("shows peer work and sends to the peer", async () => {
    const onMessage = vi.fn(async (chatId: string) => ({ status: "delivered" as const, targetChatId: chatId }))
    render(<PeerAgentRow agent={agentB!} onMessage={onMessage} />)

    expect(screen.getByText("Agent B")).toBeTruthy()
    expect(screen.getByText("src/shared.ts")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Message Agent B" }))
    fireEvent.change(screen.getByRole("textbox", { name: "Message to Agent B" }), {
      target: { value: "I am touching src/a.ts" }
    })
    fireEvent.click(screen.getByRole("button", { name: "Send" }))

    await waitFor(() => expect(onMessage).toHaveBeenCalledWith("b", "I am touching src/a.ts"))
    expect(onMessage).toHaveBeenCalledTimes(1)
  })
})
