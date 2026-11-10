import "@testing-library/jest-dom/vitest"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ProviderConnectionId, ProviderId } from "@jingler/core"
import { afterEach, describe, expect, it, vi } from "vitest"
import { type ProviderConnectRequest, ProviderConnectSheet, type ProviderConnectSheetProps } from "./provider-connect-sheet.js"

afterEach(cleanup)

const VERIFIED_TEXT = /Verified · OpenAI API/u
const connectionId = ProviderConnectionId.make("c1")
const codex: ProviderConnectRequest = { connectionId, providerId: ProviderId.make("openai-codex"), mode: "subscription" }
const claude: ProviderConnectRequest = { connectionId, providerId: ProviderId.make("anthropic"), mode: "subscription" }

const renderSheet = (props: Partial<ProviderConnectSheetProps> = {}) =>
  render(
    <ProviderConnectSheet
      open
      onOpenChange={() => {}}
      request={codex}
      onStartLogin={() => new Promise(() => {})}
      onCancelLogin={async () => {}}
      onReopenBrowser={() => {}}
      onSaveApiKey={async () => ({ ok: true })}
      {...props}
    />
  )

describe("ProviderConnectSheet", () => {
  it("shows the waiting card while the browser login runs; Cancel stops it", async () => {
    const user = userEvent.setup()
    const onStartLogin = vi.fn(() => new Promise<void>(() => {}))
    const onCancelLogin = vi.fn().mockResolvedValue(undefined)
    const onReopenBrowser = vi.fn()
    renderSheet({ onStartLogin, onCancelLogin, onReopenBrowser })

    await user.click(screen.getByRole("button", { name: "Open browser" }))
    expect(onStartLogin).toHaveBeenCalledWith("browser")
    expect(await screen.findByText("Waiting for browser…")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Reopen browser" }))
    expect(onReopenBrowser).toHaveBeenCalledOnce()

    await user.click(screen.getByRole("button", { name: "Cancel" }))
    expect(onCancelLogin).toHaveBeenCalledOnce()
    expect(await screen.findByRole("button", { name: "Open browser" })).toBeInTheDocument()
  })

  it("closes once the login resolves", async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    const onConnected = vi.fn()
    renderSheet({ onStartLogin: async () => {}, onOpenChange, onConnected })

    await user.click(screen.getByRole("button", { name: "Open browser" }))
    await vi.waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    expect(onConnected).toHaveBeenCalledOnce()
  })

  it("shows the device code once the device-code login reports one", async () => {
    const user = userEvent.setup()
    const { rerender } = renderSheet()
    await user.click(screen.getByRole("button", { name: "Use device code" }))
    expect(await screen.findByText("Requesting a device code…")).toBeInTheDocument()

    rerender(
      <ProviderConnectSheet
        open
        onOpenChange={() => {}}
        request={codex}
        deviceCode={{ userCode: "WDJB-MJHT", verificationUri: "https://login.example.test/device", expiresInSeconds: 600 }}
        onStartLogin={() => new Promise(() => {})}
        onCancelLogin={async () => {}}
        onReopenBrowser={() => {}}
        onSaveApiKey={async () => ({ ok: true })}
      />
    )
    expect(await screen.findByTestId("device-code")).toHaveTextContent("WDJB-MJHT")
    expect(screen.getByText("Waiting for you to approve in the browser…")).toBeInTheDocument()
  })

  it("Claude runs the CLI check and shows the claude auth login hint when it fails", async () => {
    const user = userEvent.setup()
    const onStartLogin = vi.fn().mockRejectedValue(new Error("Claude Code is not signed in"))
    renderSheet({ request: claude, onStartLogin })

    expect(screen.queryByRole("button", { name: "Open browser" })).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Connect with Claude Code" }))
    expect(onStartLogin).toHaveBeenCalledWith("claude-cli")
    expect(await screen.findByText("Claude Code is not signed in")).toBeInTheDocument()
    expect(screen.getByText(/on this device, then try again/u)).toBeInTheDocument()
  })

  it("an invalid key keeps the typed value and shows the error", async () => {
    const user = userEvent.setup()
    const onSaveApiKey = vi.fn().mockResolvedValue({ ok: false, error: "Invalid API key" })
    renderSheet({ onSaveApiKey })

    await user.click(screen.getByRole("tab", { name: "API key" }))
    const input = screen.getByPlaceholderText("Provider API key")
    await user.type(input, "sk-bad-key")
    await user.click(screen.getByRole("button", { name: "Test & save" }))

    expect(await screen.findByText("Invalid API key")).toBeInTheDocument()
    expect(onSaveApiKey).toHaveBeenCalledWith("openai", "sk-bad-key")
    expect(input).toHaveValue("sk-bad-key")
  })

  it("a verified key shows Verified and closes only on Done", async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    renderSheet({ onOpenChange })

    await user.click(screen.getByRole("tab", { name: "API key" }))
    await user.type(screen.getByPlaceholderText("Provider API key"), "sk-good")
    await user.click(screen.getByRole("button", { name: "Test & save" }))

    expect(await screen.findByText(VERIFIED_TEXT)).toBeInTheDocument()
    expect(onOpenChange).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: "Done" }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("an api-key request opens straight on the key form with no subscription tab", () => {
    renderSheet({ request: { connectionId, providerId: ProviderId.make("openrouter"), mode: "api-key" } })
    expect(screen.queryByRole("tab", { name: "Subscription" })).not.toBeInTheDocument()
    expect(screen.getByPlaceholderText("Provider API key")).toBeInTheDocument()
  })
})
