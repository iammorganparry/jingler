// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Composer } from "./composer.js"

afterEach(cleanup)
const environments = [{ kind: "owned" as const, id: "buildbox", name: "buildbox", platform: { os: "darwin", arch: "arm64" }, capabilities: { version: 1, capabilities: ["session.start"], harnesses: ["claude" as const], maxConcurrentSessions: 4 }, state: "online" as const, agentVersion: "2.0.3", lastSeenAt: 1 }]
const cloudEnvironment = { kind: "managed" as const, id: "cloud", name: "Cloud", platform: { os: "linux", arch: "x64" }, capabilities: { version: 1, capabilities: ["session.start"], harnesses: ["codex" as const], maxConcurrentSessions: 1 }, state: "online" as const, agentVersion: null, lastSeenAt: null, region: null, instanceType: "basic" as const, generation: 1, createdAt: 0, updatedAt: 0 }

describe("composer environment selector", () => {
  it("uses a monitor for Local and a server for paired hosts", () => {
    render(<Composer environments={environments} onSetEnvironment={() => {}} />)
    const trigger = screen.getByRole("button", { name: "Execution environment" })
    expect(trigger.querySelector('[data-environment-icon="local"]')).not.toBeNull()
    fireEvent.click(trigger)
    expect(
      screen
        .getByRole("option", { name: "buildbox" })
        .querySelector('[data-environment-icon="remote"]')
    ).not.toBeNull()
  })

  it("uses a cloud icon for managed environments", () => {
    render(<Composer environments={[cloudEnvironment]} onSetEnvironment={() => {}} />)
    const trigger = screen.getByRole("button", { name: "Execution environment" })
    fireEvent.click(trigger)
    expect(
      screen
        .getByRole("option", { name: "Cloud" })
        .querySelector('[data-environment-icon="cloud"]')
    ).not.toBeNull()
  })

  it("selects Local and reports the environment change", () => {
    const select = vi.fn()
    render(<Composer environments={environments} environmentId="buildbox" onSetEnvironment={select} />)
    const trigger = screen.getByRole("button", { name: "Execution environment" })
    expect(trigger.textContent).toContain("buildbox")
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole("option", { name: "Local" }))
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
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole("option", { name: "buildbox" }))
    expect(select).toHaveBeenCalledWith("buildbox")
  })
  it("shows offline and incompatible environment states", () => {
    render(<Composer environments={[{ ...environments[0]!, state: "offline" }]} environmentId="buildbox" onSetEnvironment={() => {}} />)
    expect(screen.getByRole("button", { name: "Execution environment" }).textContent).toContain("offline")
  })
  it("keeps environment handoff available during an active turn", () => {
    const select = vi.fn()
    render(<Composer environments={environments} busy onSetEnvironment={select} />)
    const trigger = screen.getByRole("button", { name: "Execution environment" })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole("option", { name: "buildbox" }))
    expect(select).toHaveBeenCalledWith("buildbox")
  })

  it("shows the actual reason the composer is temporarily unavailable", () => {
    render(
      <Composer
        environments={[cloudEnvironment]}
        environmentId="cloud"
        disabledReason="Loading branches…"
        onSetEnvironment={() => {}}
      />
    )
    expect(screen.getByText("Loading branches…")).toBeTruthy()
    expect(screen.queryByText("harness unavailable")).toBeNull()
  })
})
