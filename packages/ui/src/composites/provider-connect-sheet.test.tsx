import "@testing-library/jest-dom/vitest"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ProviderId } from "@jingler/core"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ProviderConnectSheet } from "./provider-connect-sheet.js"

afterEach(cleanup)

const providerId = ProviderId.make("openai-codex")

describe("ProviderConnectSheet", () => {
  it("Cancel stops the login and closes the OAuth waiting state", async () => {
    const user = userEvent.setup()
    const onCancelLogin = vi.fn().mockResolvedValue(undefined)
    const onStartOauth = vi.fn().mockResolvedValue("login-1")

    render(
      <ProviderConnectSheet
        open
        onOpenChange={() => {}}
        providerId={providerId}
        providerLabel="Codex"
        onStartOauth={onStartOauth}
        onCancelLogin={onCancelLogin}
        onReopenBrowser={() => {}}
        onSaveApiKey={async () => ({ ok: true })}
      />
    )

    await user.click(screen.getByRole("button", { name: "Open browser" }))
    const cancelButton = await screen.findByRole("button", { name: "Cancel" })
    await user.click(cancelButton)

    expect(onCancelLogin).toHaveBeenCalledWith("login-1")
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Open browser" })).toBeInTheDocument()
  })

  it("an invalid key keeps the typed value and shows the error", async () => {
    const user = userEvent.setup()
    const onSaveApiKey = vi.fn().mockResolvedValue({ ok: false, error: "Invalid API key" })

    render(
      <ProviderConnectSheet
        open
        onOpenChange={() => {}}
        providerId={providerId}
        providerLabel="Codex"
        onStartOauth={async () => "login-1"}
        onCancelLogin={async () => {}}
        onReopenBrowser={() => {}}
        onSaveApiKey={onSaveApiKey}
      />
    )

    await user.click(screen.getByRole("tab", { name: "API key" }))
    const input = screen.getByPlaceholderText("Provider API key")
    await user.type(input, "sk-bad-key")
    await user.click(screen.getByRole("button", { name: "Save API key" }))

    expect(await screen.findByText("Invalid API key")).toBeInTheDocument()
    expect(onSaveApiKey).toHaveBeenCalledWith("sk-bad-key")
    expect((input as HTMLInputElement).value).toBe("sk-bad-key")
  })

  it("starts a device-code login via onStartDeviceCode when offered", async () => {
    const user = userEvent.setup()
    const onStartDeviceCode = vi.fn().mockResolvedValue("login-device-1")

    render(
      <ProviderConnectSheet
        open
        onOpenChange={() => {}}
        providerId={providerId}
        providerLabel="Codex"
        onStartOauth={async () => "login-1"}
        onStartDeviceCode={onStartDeviceCode}
        onCancelLogin={async () => {}}
        onReopenBrowser={() => {}}
        onSaveApiKey={async () => ({ ok: true })}
      />
    )

    await user.click(screen.getByRole("button", { name: "Use device code" }))

    expect(onStartDeviceCode).toHaveBeenCalledTimes(1)
    expect(await screen.findByRole("button", { name: "Cancel" })).toBeInTheDocument()
  })
})
