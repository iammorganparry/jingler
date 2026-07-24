import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Composer } from "./composer.js"

/**
 * The composer's MCP chip. Its whole job is to be honest: it must not appear
 * before we know anything, and must not claim health we haven't checked.
 */

afterEach(cleanup)

const MCP_ITEM = /MCP connectors/

const open = () =>
  fireEvent.pointerDown(screen.getByRole("button", { name: "Composer menu" }), {
    button: 0,
    ctrlKey: false
  })

describe("Composer — MCP menu status", () => {
  /**
   * Status arrives a beat after mount (same as the model catalogue). Rendering
   * "0 MCP" in that window would tell the operator their servers are missing.
   */
  it("does not claim a count until status has loaded", () => {
    render(<Composer onOpenMcp={() => {}} />)
    open()
    expect(screen.getByRole("menuitem", { name: "MCP connectors" })).toBeTruthy()
  })

  it("keeps connectors available when none are configured", () => {
    render(<Composer mcp={{ total: 0, failed: 0, probed: false }} onOpenMcp={() => {}} />)
    open()
    expect(screen.getByRole("menuitem", { name: MCP_ITEM })).toBeTruthy()
  })

  it("shows the server count once loaded", () => {
    render(<Composer mcp={{ total: 3, failed: 0, probed: false }} onOpenMcp={() => {}} />)
    open()
    expect(screen.getByRole("menuitem", { name: MCP_ITEM }).textContent).toContain("3")
  })

  /** Before a probe we know a count, not a health — so the chip must not read as green. */
  it("does not claim anything is down before a probe has run", () => {
    render(<Composer mcp={{ total: 3, failed: 0, probed: false }} onOpenMcp={() => {}} />)
    open()
    expect(screen.getByRole("menuitem", { name: MCP_ITEM }).textContent).not.toContain("down")
  })

  it("reports failures once probed", () => {
    render(<Composer mcp={{ total: 3, failed: 1, probed: true }} onOpenMcp={() => {}} />)
    open()
    expect(screen.getByRole("menuitem", { name: MCP_ITEM }).textContent).toContain("1/3 down")
  })

  it("keeps showing the plain count when a probe found everything healthy", () => {
    render(<Composer mcp={{ total: 3, failed: 0, probed: true }} onOpenMcp={() => {}} />)
    open()
    expect(screen.getByRole("menuitem", { name: MCP_ITEM }).textContent).toContain("3")
  })

  it("opens the dialog when clicked", () => {
    const onOpenMcp = vi.fn()
    render(<Composer mcp={{ total: 2, failed: 0, probed: false }} onOpenMcp={onOpenMcp} />)
    open()
    fireEvent.click(screen.getByRole("menuitem", { name: MCP_ITEM }))
    expect(onOpenMcp).toHaveBeenCalledOnce()
  })
})
