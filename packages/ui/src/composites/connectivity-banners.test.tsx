import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { DeviceOfflineBanner, OfflineBanner, RelayQuotaBanner } from "./connectivity-banners.js"

afterEach(cleanup)

describe("connectivity banners", () => {
  it("offline is a neutral top notice", () => {
    render(<OfflineBanner />)
    expect(screen.getByTestId("banner-message").textContent).toBe("Offline — agents keep running locally")
    expect(screen.getByTestId("banner-shell").className).toContain("border-hairline")
  })

  it("device offline names the device and continues locally", () => {
    const onContinueLocally = vi.fn()
    render(<DeviceOfflineBanner device="Studio-Mac" onContinueLocally={onContinueLocally} />)
    expect(screen.getByTestId("banner-message").textContent).toBe("Studio-Mac went offline — the run is paused")
    fireEvent.click(screen.getByRole("button", { name: "Continue on this Mac…" }))
    expect(onContinueLocally).toHaveBeenCalledTimes(1)
  })

  it("relay quota shows the reset date", () => {
    render(<RelayQuotaBanner resetsOn="Nov 1" />)
    expect(screen.getByTestId("banner-message").textContent).toBe("Remote runs are paused — relay quota reached · resets Nov 1")
  })
})
