/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  EnvironmentDialog,
  type EnvironmentDialogProps
} from "./environment-dialog.js"

const props: EnvironmentDialogProps = {
  open: true,
  state: "choosing",
  method: null,
  values: {
    backendUrl: "",
    pendingDeviceId: "",
    pairingCode: "",
    host: "",
    username: "",
    port: "22"
  },
  hosts: [
    {
      alias: "clive.local",
      hostname: "clive.local",
      username: null,
      port: 22,
      source: "config"
    }
  ],
  onClose: vi.fn(),
  onChoose: vi.fn(),
  onEdit: vi.fn(),
  onSelectHost: vi.fn(),
  onSubmit: vi.fn(),
  onRetry: vi.fn()
}
afterEach(cleanup)

describe("EnvironmentDialog", () => {
  it("switches between Remote link and SSH onboarding", () => {
    render(<EnvironmentDialog {...props} />)
    fireEvent.click(screen.getByRole("button", { name: /Remote link/i }))
    fireEvent.click(screen.getByRole("button", { name: /^SSH/i }))
    expect(props.onChoose).toHaveBeenNthCalledWith(1, "remote-link")
    expect(props.onChoose).toHaveBeenNthCalledWith(2, "ssh")
  })
  it("renders suggested SSH hosts and selects clive.local", () => {
    render(<EnvironmentDialog {...props} method="ssh" state="configuring" />)
    fireEvent.click(screen.getByText("clive.local"))
    expect(props.onSelectHost).toHaveBeenCalledWith(props.hosts[0])
  })
  it("disables submission until the selected method is valid", () => {
    const view = render(
      <EnvironmentDialog {...props} method="ssh" state="configuring" />
    )
    expect(
      screen
        .getByRole("button", { name: "Connect environment" })
        .hasAttribute("disabled")
    ).toBe(true)
    view.rerender(
      <EnvironmentDialog
        {...props}
        method="ssh"
        state="configuring"
        values={{ ...props.values, host: "clive.local" }}
      />
    )
    expect(
      screen
        .getByRole("button", { name: "Connect environment" })
        .hasAttribute("disabled")
    ).toBe(false)
  })
})
