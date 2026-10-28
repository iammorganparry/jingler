// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

const { appRevealLogs } = vi.hoisted(() => ({ appRevealLogs: vi.fn().mockResolvedValue(undefined) }))
vi.mock("./rpc-client.js", () => ({ rpc: { appRevealLogs } }))

import { RootErrorBoundary } from "./root-error-boundary.js"

afterEach(cleanup)

const Boom = () => {
  throw new Error("boom")
}

describe("RootErrorBoundary", () => {
  it("shows the crash card with all three actions and opens logs", () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    render(<RootErrorBoundary><Boom /></RootErrorBoundary>)
    expect(screen.getByRole("heading", { name: "Jingler hit an error" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Reload window" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Copy error details" })).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Open logs" }))
    expect(appRevealLogs).toHaveBeenCalledOnce()
  })

  it("renders children when nothing throws", () => {
    render(<RootErrorBoundary><span>fine</span></RootErrorBoundary>)
    expect(screen.getByText("fine")).toBeTruthy()
  })
})
