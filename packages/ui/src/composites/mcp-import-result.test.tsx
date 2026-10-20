// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { McpImportResult } from "./mcp-import-result.js"

afterEach(cleanup)

describe("McpImportResult", () => {
  it("offers Connect only on needs-auth and View log only on failed rows", () => {
    const onConnect = vi.fn()
    const onViewLog = vi.fn()
    render(<McpImportResult onConnect={onConnect} onViewLog={onViewLog} rows={[
      { name: "ok", status: "imported" },
      { name: "oauth", status: "needs-auth" },
      { name: "bad", status: "failed" }
    ]} />)
    expect(screen.getAllByRole("button")).toHaveLength(2)
    fireEvent.click(screen.getByRole("button", { name: "Connect" }))
    fireEvent.click(screen.getByRole("button", { name: "View log" }))
    expect(onConnect).toHaveBeenCalledWith("oauth")
    expect(onViewLog).toHaveBeenCalledWith("bad")
  })
})
