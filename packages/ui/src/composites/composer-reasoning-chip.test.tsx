import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { testProviderCatalog } from "../test-support.js"
import { Composer } from "./composer.js"

afterEach(cleanup)

const catalog = testProviderCatalog(["low", "medium", "high", "xhigh"])
const { id: connectionId } = catalog.connections[0]!.connection
const { id: modelId } = catalog.connections[0]!.models[0]!

describe("Composer thinking strength", () => {
  it("shows the provider default until the session overrides it", () => {
    render(<Composer />)
    expect(screen.getByRole("button", { name: "Thinking strength" }).textContent).toContain(
      "Default"
    )
  })

  it("reports a provider-native strength and can restore the default", () => {
    const onSetReasoning = vi.fn()
    const { rerender } = render(
      <Composer providerCatalog={catalog} connectionId={connectionId} modelId={modelId} reasoningEffort="low" onSetReasoning={onSetReasoning} />
    )

    fireEvent.click(screen.getByRole("button", { name: "Thinking strength" }))
    expect(screen.getByRole("option", { name: "Low" })).toBeDefined()
    expect(screen.getByRole("option", { name: "Off" })).toBeDefined()
    expect(screen.getByRole("option", { name: "Medium (default)" })).toBeDefined()
    expect(screen.queryByRole("option", { name: "Medium" })).toBeNull()
    fireEvent.click(screen.getByRole("option", { name: "Xhigh" }))
    expect(onSetReasoning).toHaveBeenCalledWith({ enabled: true, effort: "xhigh" })

    rerender(<Composer providerCatalog={catalog} connectionId={connectionId} modelId={modelId} reasoningEffort="low" onSetReasoning={onSetReasoning} />)
    fireEvent.click(screen.getByRole("button", { name: "Thinking strength" }))
    fireEvent.click(screen.getByRole("option", { name: "Medium (default)" }))
    expect(onSetReasoning).toHaveBeenLastCalledWith(undefined)
  })

  it("hides Off when pi says the selected model cannot disable reasoning", () => {
    const alwaysThinking = testProviderCatalog(["medium", "high", "max"], false)
    render(
      <Composer
        providerCatalog={alwaysThinking}
        connectionId={alwaysThinking.connections[0]!.connection.id}
        modelId={alwaysThinking.connections[0]!.models[0]!.id}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "Thinking strength" }))
    expect(screen.queryByRole("option", { name: "Off" })).toBeNull()
    expect(screen.getByRole("option", { name: "Max" })).toBeDefined()
  })

  it("hides the thinking control for a model without reasoning support", () => {
    const plainModel = testProviderCatalog()
    render(
      <Composer
        providerCatalog={plainModel}
        connectionId={plainModel.connections[0]!.connection.id}
        modelId={plainModel.connections[0]!.models[0]!.id}
      />
    )

    expect(screen.queryByRole("button", { name: "Thinking strength" })).toBeNull()
  })
})
