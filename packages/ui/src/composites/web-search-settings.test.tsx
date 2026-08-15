/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WebSearchSettings } from "./web-search-settings.js"

const status = {
  config: { setup: "pending" as const, provider: null },
  credentials: [
    { provider: "exa" as const, configured: false, cloudSynced: false, validatedAt: null },
    { provider: "firecrawl" as const, configured: false, cloudSynced: false, validatedAt: null }
  ]
}

afterEach(cleanup)

describe("WebSearch settings", () => {
  it("submits a write-only key and clears the input", async () => {
    const save = vi.fn(async () => undefined)
    render(
      <WebSearchSettings
        status={status}
        onSave={save}
        onClear={vi.fn()}
        onSkip={vi.fn()}
      />
    )
    expect(document.querySelectorAll("img[data-provider-logo]")).toHaveLength(2)
    const input = screen.getByLabelText("EXA API key") as HTMLInputElement
    fireEvent.change(input, { target: { value: "exa-secret-key" } })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(save).toHaveBeenCalledWith("exa", "exa-secret-key"))
    expect(input.value).toBe("")
    expect(screen.queryByDisplayValue("exa-secret-key")).toBeNull()
  })

  it("clears a typed key when switching providers", () => {
    render(
      <WebSearchSettings
        status={status}
        onSave={vi.fn()}
        onClear={vi.fn()}
        onSkip={vi.fn()}
      />
    )
    fireEvent.change(screen.getByLabelText("EXA API key"), {
      target: { value: "exa-secret-key" }
    })
    fireEvent.click(screen.getByRole("tab", { name: "Firecrawl" }))
    expect((screen.getByLabelText("Firecrawl API key") as HTMLInputElement).value).toBe("")
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true)
  })

  it("shows cloud sync state without displaying a saved key", () => {
    render(
      <WebSearchSettings
        status={{
          config: { setup: "configured", provider: "exa" },
          credentials: [
            { provider: "exa", configured: true, cloudSynced: true, validatedAt: null },
            { provider: "firecrawl", configured: false, cloudSynced: false, validatedAt: null }
          ]
        }}
        onSave={vi.fn()}
        onClear={vi.fn()}
        onSkip={vi.fn()}
      />
    )
    expect(screen.getByText("Encrypted locally · synced for Cloud")).toBeTruthy()
    expect(screen.getByPlaceholderText(/key configured/i)).toBeTruthy()
  })
})
