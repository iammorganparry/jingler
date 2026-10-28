import "@testing-library/jest-dom/vitest"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DeviceCodeBlock } from "./device-code-block.js"

afterEach(cleanup)

describe("DeviceCodeBlock", () => {
  it("shows the code and verification URL, and copies the code", async () => {
    const user = userEvent.setup()
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } })

    render(
      <DeviceCodeBlock
        code="JING-LER1"
        verificationUri="https://login.example.test/device"
        expiresInSeconds={600}
        onReopenBrowser={() => {}}
      />
    )

    expect(screen.getByTestId("device-code")).toHaveTextContent("JING-LER1")
    expect(screen.getByText("https://login.example.test/device")).toBeInTheDocument()
    expect(screen.getByTestId("device-code-countdown")).toHaveTextContent("10:00")

    await user.click(screen.getByRole("button", { name: "Copy code" }))
    expect(writeText).toHaveBeenCalledWith("JING-LER1")
    vi.unstubAllGlobals()
  })

  it("calls onReopenBrowser when the reopen button is clicked", async () => {
    const user = userEvent.setup()
    const onReopenBrowser = vi.fn()
    render(
      <DeviceCodeBlock
        code="ABCD-1234"
        verificationUri="https://login.example.test/device"
        expiresInSeconds={null}
        onReopenBrowser={onReopenBrowser}
      />
    )

    expect(screen.queryByTestId("device-code-countdown")).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Reopen browser" }))
    expect(onReopenBrowser).toHaveBeenCalledOnce()
  })
})
