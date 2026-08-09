// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Composer } from "./composer.js"

afterEach(cleanup)
const environments = [{ id: "buildbox", name: "buildbox", platform: { os: "darwin", arch: "arm64" }, capabilities: { version: 1, capabilities: ["session.start"], harnesses: ["claude" as const], maxConcurrentSessions: 4 }, state: "online" as const, agentVersion: "2.0.3", lastSeenAt: 1 }]

describe("composer environment selector", () => {
  it("selects Local and reports the environment change", () => {
    const select = vi.fn()
    render(<Composer environments={environments} environmentId="buildbox" onSetEnvironment={select} />)
    const trigger = screen.getByRole("button", { name: "Execution environment" })
    expect(trigger.textContent).toContain("buildbox")
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })
    fireEvent.click(screen.getByRole("menuitem", { name: "Local" }))
    expect(select).toHaveBeenCalledWith(undefined)
  })
  it("selects an account-owned device and reports the environment change", () => {
    const select = vi.fn()
    render(
      <Composer
        environments={environments}
        onSetEnvironment={select}
      />
    )
    const trigger = screen.getByRole("button", {
      name: "Execution environment"
    })
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })
    fireEvent.click(screen.getByRole("menuitem", { name: "buildbox" }))
    expect(select).toHaveBeenCalledWith("buildbox")
  })
  it("shows offline and incompatible environment states", () => {
    render(<Composer environments={[{ ...environments[0]!, state: "offline" }]} environmentId="buildbox" onSetEnvironment={() => {}} />)
    expect(screen.getByRole("button", { name: "Execution environment" }).textContent).toContain("offline")
  })
  it("disables environment changes during an active turn", () => {
    render(<Composer environments={environments} busy onSetEnvironment={() => {}} />)
    expect(screen.getByTitle("Local").tagName).toBe("SPAN")
  })
})
