/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { GitHubConnection, ProviderConnectionId } from "@jingler/core"
import { afterEach, describe, expect, it, vi } from "vitest"
import { SetupScreen, type SetupScreenProps } from "./setup-screen.js"

afterEach(cleanup)

const github: GitHubConnection = {
  mode: "disconnected",
  enabled: true,
  connected: false,
  user: null,
  installations: [],
  lastRefreshedAt: null,
  error: null
}

const props = (overrides: Partial<SetupScreenProps> = {}): SetupScreenProps => ({
  step: "workspace",
  github,
  onChooseDir: vi.fn(),
  onContinue: vi.fn(),
  onConnectGithub: vi.fn(),
  onSkipGithub: vi.fn(),
  onConnectClaude: vi.fn(),
  onStartCodex: vi.fn(),
  onConnectApi: vi.fn(),
  onSelectModel: vi.fn(),
  onCancelAuth: vi.fn(),
  onRetryProvider: vi.fn(),
  onImportResources: vi.fn(),
  onSkipResources: vi.fn(),
  onCancelResourceImport: vi.fn(),
  onRetryResources: vi.fn(),
  ...overrides
})

describe("SetupScreen", () => {
  it("does not present a provider harness picker", () => {
    render(<SetupScreen {...props()} />)
    expect(screen.queryByText("HARNESSES")).toBeNull()
    expect(screen.queryByText(/Claude Code|Codex CLI|opencode/u)).toBeNull()
  })

  it("submits a Claude setup-token once and clears the password field", () => {
    const onConnectClaude = vi.fn()
    render(<SetupScreen {...props({ step: "provider", onConnectClaude })} />)
    const input = screen.getByPlaceholderText("Claude setup-token") as HTMLInputElement
    fireEvent.change(input, { target: { value: "setup-token-secret" } })
    fireEvent.click(screen.getByRole("button", { name: "Connect Claude" }))

    expect(onConnectClaude).toHaveBeenCalledWith("setup-token-secret")
    expect(input.value).toBe("")
    expect(input.type).toBe("password")
  })

  it("offers browser and device-code Codex subscription login", () => {
    const onStartCodex = vi.fn()
    render(<SetupScreen {...props({ step: "provider", onStartCodex })} />)
    fireEvent.click(screen.getByRole("button", { name: "Open browser" }))
    fireEvent.click(screen.getByRole("button", { name: "Use device code" }))
    expect(onStartCodex).toHaveBeenNthCalledWith(1, "browser")
    expect(onStartCodex).toHaveBeenNthCalledWith(2, "device-code")
  })

  it("presents a device code without exposing OAuth credentials", () => {
    render(
      <SetupScreen
        {...props({
          step: "provider",
          busy: true,
          providerLoginEvent: {
            type: "device-code",
            connectionId: "codex-1" as ProviderConnectionId,
            userCode: "ABCD-EFGH",
            verificationUri: "https://example.test/device",
            expiresInSeconds: 600
          }
        })}
      />
    )
    expect(screen.getByText("ABCD-EFGH")).toBeTruthy()
    expect(screen.getByText("https://example.test/device")).toBeTruthy()
  })
})
