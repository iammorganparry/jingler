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
    fireEvent.click(screen.getByRole("option", { name: "Xhigh" }))
    expect(onSetReasoning).toHaveBeenCalledWith({ enabled: true, effort: "xhigh" })

    rerender(<Composer providerCatalog={catalog} connectionId={connectionId} modelId={modelId} reasoningEffort="low" onSetReasoning={onSetReasoning} />)
    fireEvent.click(screen.getByRole("button", { name: "Thinking strength" }))
    fireEvent.click(screen.getByRole("option", { name: "Default" }))
    expect(onSetReasoning).toHaveBeenLastCalledWith(undefined)
  })
})
