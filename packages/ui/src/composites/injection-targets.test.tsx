import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { McpInjectionTarget } from "@starbase/core"
import { InjectionTargets } from "./injection-targets.js"

afterEach(cleanup)

const injected = (cli: McpInjectionTarget["cli"]): McpInjectionTarget => ({
  cli,
  serverName: "open-connector",
  injected: true,
  url: "http://localhost:3000/mcp",
  headerKeys: ["Authorization"],
  skipped: null
})

const skipped = (
  cli: McpInjectionTarget["cli"],
  reason: NonNullable<McpInjectionTarget["skipped"]>
): McpInjectionTarget => ({
  cli,
  serverName: "open-connector",
  injected: false,
  url: null,
  headerKeys: [],
  skipped: reason
})

const row = (label: string) => screen.getByLabelText(label)

describe("InjectionTargets", () => {
  it("shows the endpoint each harness is actually launched with", () => {
    render(<InjectionTargets targets={[injected("claude"), injected("codex")]} />)

    for (const label of ["Claude Code", "Codex"]) {
      expect(within(row(label)).getByText("injected")).toBeTruthy()
      expect(within(row(label)).getByText(/http:\/\/localhost:3000\/mcp/)).toBeTruthy()
    }
  })

  /**
   * The four "off" states are the point: from the settings screen alone a disabled
   * master switch, a per-harness opt-out and a missing token look identical, and
   * each has a different fix.
   */
  it("names the reason a harness is not receiving tools", () => {
    render(
      <InjectionTargets
        targets={[
          skipped("claude", "no-token"),
          skipped("codex", "opted-out"),
          skipped("opencode", "disabled"),
          skipped("cursor", "no-run-path")
        ]}
      />
    )

    expect(within(row("Claude Code")).getByText(/No API token/)).toBeTruthy()
    expect(within(row("Codex")).getByText(/Switched off/)).toBeTruthy()
    expect(within(row("opencode")).getByText(/Turn on Enable/)).toBeTruthy()
    expect(within(row("Cursor")).getByText(/does not launch/)).toBeTruthy()
  })

  it("toggles one harness without touching the others", () => {
    const onToggle = vi.fn()
    render(<InjectionTargets targets={[injected("claude"), injected("codex")]} onToggle={onToggle} />)

    fireEvent.click(screen.getByRole("switch", { name: "Inject into Codex" }))
    expect(onToggle).toHaveBeenCalledWith("codex", false)
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it("re-enables a harness that was opted out", () => {
    const onToggle = vi.fn()
    render(<InjectionTargets targets={[skipped("codex", "opted-out")]} onToggle={onToggle} />)

    const toggle = screen.getByRole("switch", { name: "Inject into Codex" })
    expect(toggle.getAttribute("data-state")).toBe("unchecked")
    fireEvent.click(toggle)
    expect(onToggle).toHaveBeenCalledWith("codex", true)
  })

  /** A control that cannot change the outcome is worse than none: it implies it can. */
  it("offers no toggle for a harness Starbase cannot launch", () => {
    render(<InjectionTargets targets={[skipped("cursor", "no-run-path")]} onToggle={vi.fn()} />)

    expect(screen.queryByRole("switch", { name: "Inject into Cursor" })).toBeNull()
  })
})
