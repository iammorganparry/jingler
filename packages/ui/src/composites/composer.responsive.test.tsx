import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WidthTierValue } from "../hooks/width-tier.js"
import { testProviderCatalog } from "../test-support.js"
import { Composer } from "./composer.js"

afterEach(cleanup)

const MCP_ITEM = /MCP connectors/
const catalog = testProviderCatalog(["low", "high"])
const { id: connectionId } = catalog.connections[0]!.connection
const { id: modelId } = catalog.connections[0]!.models[0]!

const renderAt = (width: number, props: Partial<React.ComponentProps<typeof Composer>> = {}) =>
  render(
    <WidthTierValue width={width}>
      <Composer {...props} />
    </WidthTierValue>
  )

const openMenu = () => fireEvent.click(screen.getByRole("button", { name: "Composer menu" }))

describe("Composer at width", () => {
  it("keeps decorative keyboard hints out even when there is room", () => {
    renderAt(1000)
    expect(screen.queryByText("/ · @ · paste image")).toBeNull()
  })

  it("keeps Send visible and collapses settings only below the mid tier", () => {
    renderAt(700)
    expect(screen.getByRole("button", { name: /Send/ })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Thinking strength" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Composer options" })).toBeNull()

    cleanup()
    renderAt(450)
    expect(screen.getByRole("button", { name: /Send/ })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Composer options" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Thinking strength" })).toBeNull()
  })

  it("keeps all four selections in the compact settings popover", () => {
    const onSetModel = vi.fn()
    const onSetEnvironment = vi.fn()
    const onSetMode = vi.fn()
    const onSetReasoning = vi.fn()
    renderAt(450, {
      providerCatalog: catalog,
      connectionId,
      modelId,
      onSetModel,
      onSetEnvironment,
      onSetMode,
      onSetReasoning,
      environments: [{
        id: "remote",
        name: "Remote",
        kind: "owned",
        platform: { os: "darwin", arch: "arm64" },
        capabilities: { version: 1, capabilities: ["session.start"], maxConcurrentSessions: 1 },
        state: "online",
        agentVersion: "2.0.3",
        lastSeenAt: Date.now()
      }]
    })

    fireEvent.click(screen.getByRole("button", { name: "Composer options" }))
    for (const label of ["Model", "Environment", "Permission", "Reasoning"])
      expect(screen.getByText(label)).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Model: GPT Test" }))
    fireEvent.click(screen.getByRole("option", { name: /GPT Test/i }))
    expect(onSetModel).toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: "Execution environment" }))
    fireEvent.click(screen.getByRole("option", { name: "Remote" }))
    expect(onSetEnvironment).toHaveBeenCalledWith("remote")

    fireEvent.click(screen.getByRole("button", { name: "Auto" }))
    fireEvent.click(screen.getByRole("option", { name: /Ask/ }))
    expect(onSetMode).toHaveBeenCalledWith("ask")

    fireEvent.click(screen.getByRole("button", { name: "Thinking strength" }))
    fireEvent.click(screen.getByRole("option", { name: "Low" }))
    expect(onSetReasoning).toHaveBeenCalledWith({ enabled: true, effort: "low" })
  })

  it("no longer offers MCP in the menu at any width (it lives in Settings › Connectors)", () => {
    renderAt(450)
    openMenu()
    expect(screen.queryByRole("button", { name: MCP_ITEM })).toBeNull()
  })

  it("keeps the composer menu findable by the same name at any width", () => {
    for (const width of [1200, 450, 320]) {
      cleanup()
      renderAt(width)
      expect(screen.getByRole("button", { name: "Composer menu" })).toBeTruthy()
    }
  })
})
