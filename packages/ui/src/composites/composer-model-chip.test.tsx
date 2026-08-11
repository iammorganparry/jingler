import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { testProviderCatalog } from "../test-support.js"
import { Composer } from "./composer.js"

afterEach(cleanup)

const catalog = testProviderCatalog()
const { id: connectionId } = catalog.connections[0]!.connection
const { id: modelId } = catalog.connections[0]!.models[0]!

describe("Composer model chip", () => {
  it("shows the selected certified provider model", () => {
    render(
      <Composer
        providerCatalog={catalog}
        connectionId={connectionId}
        modelId={modelId}
      />
    )

    expect(screen.getByRole("button", { name: "Model: GPT Test" })).toBeTruthy()
  })

  it("keeps model recovery enabled while sending is blocked", () => {
    const onSend = vi.fn()
    render(
      <Composer
        providerCatalog={catalog}
        connectionId={connectionId}
        modelId={modelId}
        disabledReason="This model certification is stale. Choose another model."
        onSend={onSend}
      />
    )

    expect(
      (screen.getByPlaceholderText(/certification is stale/) as HTMLTextAreaElement).disabled
    ).toBe(true)
    expect(screen.queryByRole("button", { name: "Send ↵" })).toBeNull()
    expect(
      (screen.getByRole("button", { name: "Model: GPT Test" }) as HTMLButtonElement).disabled
    ).toBe(false)
    expect(onSend).not.toHaveBeenCalled()
  })
})
