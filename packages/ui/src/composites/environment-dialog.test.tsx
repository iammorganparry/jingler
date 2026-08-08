/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  EnvironmentDialog,
  type EnvironmentDialogProps
} from "./environment-dialog.js"

const props: EnvironmentDialogProps = {
  open: true,
  state: "configuring",
  values: {
    host: ""
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
  onEdit: vi.fn(),
  onSelectHost: vi.fn(),
  onSubmit: vi.fn(),
  onRetry: vi.fn()
}
afterEach(cleanup)

describe("EnvironmentDialog", () => {
  it("opens directly into SSH onboarding", () => {
    render(<EnvironmentDialog {...props} />)
    expect(screen.getByLabelText("SSH host or alias")).toBeTruthy()
    expect(screen.queryByRole("button", { name: /Remote link/i })).toBeNull()
    expect(screen.queryByLabelText("Backend host")).toBeNull()
    expect(screen.queryByLabelText("Device ID")).toBeNull()
    expect(screen.queryByLabelText("Pairing code")).toBeNull()
  })
  it("renders suggested SSH hosts and selects clive.local", () => {
    render(<EnvironmentDialog {...props} />)
    fireEvent.click(screen.getByText("clive.local"))
    expect(props.onSelectHost).toHaveBeenCalledWith(props.hosts[0])
    expect(screen.queryByLabelText("Username")).toBeNull()
    expect(screen.queryByLabelText("Port")).toBeNull()
    expect(
      screen.getByText(/Uses this alias exactly as your terminal does/)
    ).toBeTruthy()
  })
  it("disables submission until the selected method is valid", () => {
    const view = render(
      <EnvironmentDialog {...props} />
    )
    expect(
      screen
        .getByRole("button", { name: "Connect environment" })
        .hasAttribute("disabled")
    ).toBe(true)
    view.rerender(
      <EnvironmentDialog
        {...props}
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
