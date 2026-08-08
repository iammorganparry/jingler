/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { Environment } from "@jingler/core"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DevicesSection } from "./settings-view.js"

const base: Environment = {
  id: "device-1",
  name: "clive.local",
  platform: { os: "darwin", arch: "arm64" },
  capabilities: {
    version: 1,
    capabilities: [],
    harnesses: ["codex"],
    maxConcurrentSessions: 1
  },
  state: "online",
  agentVersion: "1.0.0",
  lastSeenAt: 100
}
const dialog = {
  open: false,
  state: "choosing" as const,
  method: null,
  values: {
    backendUrl: "",
    pendingDeviceId: "",
    pairingCode: "",
    host: "",
    username: "",
    port: "22"
  },
  hosts: [],
  onClose: vi.fn(),
  onChoose: vi.fn(),
  onEdit: vi.fn(),
  onSelectHost: vi.fn(),
  onSubmit: vi.fn(),
  onRetry: vi.fn()
}
afterEach(cleanup)

describe("Devices settings", () => {
  it("renders paired device connection and compatibility states", () => {
    render(
      <DevicesSection
        environments={[
          base,
          { ...base, id: "device-2", name: "old-mini", state: "incompatible" }
        ]}
        loading={false}
        dialog={dialog}
        onOpen={vi.fn()}
        onRefresh={vi.fn()}
        onRename={vi.fn()}
        onRevoke={vi.fn()}
      />
    )
    expect(screen.getByText("online")).toBeTruthy()
    expect(screen.getByText("incompatible")).toBeTruthy()
  })
  it("confirms before revoking an environment", () => {
    const revoke = vi.fn()
    vi.spyOn(window, "confirm")
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true)
    render(
      <DevicesSection
        environments={[base]}
        loading={false}
        dialog={dialog}
        onOpen={vi.fn()}
        onRefresh={vi.fn()}
        onRename={vi.fn()}
        onRevoke={revoke}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }))
    expect(revoke).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }))
    expect(revoke).toHaveBeenCalledWith("device-1")
  })
})
