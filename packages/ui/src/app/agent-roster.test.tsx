// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { AgentRoster } from "./agent-roster.js"

afterEach(cleanup)

const agents = [
  { chatId: "a", title: "Agent A", status: "running" as const, task: "Plan A", planStage: "Stage A", touchedFiles: ["src/a.ts"], updatedAt: "now" },
  { chatId: "b", title: "Agent B", status: "needs-input" as const, task: "Plan B", planStage: null, touchedFiles: ["src/shared.ts"], updatedAt: "now" }
]

describe("AgentRoster", () => {
  it("prevents duplicate sends and reports a rejected delivery", async () => {
    const onMessage = vi.fn(async () => {
      throw new Error("offline")
    })
    render(<AgentRoster agents={agents} currentChatId="a" onMessage={onMessage} />)
    fireEvent.click(screen.getByText("Peer agents"))
    fireEvent.click(screen.getByRole("button", { name: "Message Agent B" }))
    fireEvent.change(screen.getByRole("textbox", { name: "Message to Agent B" }), {
      target: { value: "hello" }
    })
    const send = screen.getByRole("button", { name: "Send" })
    fireEvent.click(send)
    fireEvent.click(send)

    await waitFor(() => expect(screen.getByText("failed")).toBeTruthy())
    expect(onMessage).toHaveBeenCalledOnce()
  })

  it("shows peer work and sends only to the selected peer", async () => {
    const onMessage = vi.fn(async (chatId: string) => ({ status: "delivered" as const, targetChatId: chatId }))
    render(<AgentRoster agents={agents} currentChatId="a" onMessage={onMessage} />)

    fireEvent.click(screen.getByText("Peer agents"))
    expect(screen.queryByText("Agent A")).toBeNull()
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
