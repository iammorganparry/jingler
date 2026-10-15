import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  AssetBinary,
  AssetError,
  AssetLoading,
  AssetTooLarge,
  AssetUnsupported
} from "./asset-view.js"

afterEach(cleanup)

describe("asset viewer states", () => {
  it("draws loading as a busy state", () => {
    const { container } = render(<AssetLoading />)
    expect(screen.getByText("Loading…")).toBeTruthy()
    expect(container.querySelector("[aria-busy='true']")).not.toBeNull()
  })

  it.each([
    ["too large", <AssetTooLarge path="huge.log" size={44_123_456} cap={5 * 1024 * 1024} onReveal={() => {}} />, "File too large to preview"],
    ["unsupported", <AssetUnsupported path="archive.zip" onReveal={() => {}} />, "No preview available"],
    ["binary", <AssetBinary onReveal={() => {}} />, "Binary file"]
  ])("offers Open externally on the %s state", (_name, node, title) => {
    render(node)
    expect(screen.getByText(title)).toBeTruthy()
    expect(screen.getByRole("button", { name: "Open externally" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull()
  })

  it("shows the size and cap on the too-large state", () => {
    render(<AssetTooLarge path="huge.log" size={44_123_456} cap={5 * 1024 * 1024} />)
    expect(screen.getByText(/huge\.log is 42\.1 MB — over the 5\.0 MB preview limit/u)).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Open externally" })).toBeNull()
  })

  it("re-issues the read from the error state's Retry", () => {
    const onRetry = vi.fn()
    const onReveal = vi.fn()
    render(<AssetError message="ENOENT" onRetry={onRetry} onReveal={onReveal} />)
    expect(screen.getByRole("alert")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    fireEvent.click(screen.getByRole("button", { name: "Open externally" }))
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(onReveal).toHaveBeenCalledTimes(1)
  })
})
