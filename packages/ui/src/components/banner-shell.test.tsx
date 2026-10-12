import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { BannerShell } from "./banner-shell.js"
import { Callout } from "./callout.js"

afterEach(cleanup)

describe("BannerShell", () => {
  it.each(["top", "lane", "card"] as const)("has no coloured fill at placement %s", (placement) => {
    render(<BannerShell placement={placement} failed icon="!">Sync failed</BannerShell>)
    expect(screen.getByTestId("banner-shell").className).not.toMatch(/\bbg-/)
  })

  it("truncates the message while actions stay on one line", () => {
    render(<BannerShell actions={[<button key="a" type="button">Restore</button>, <button key="b" type="button">Delete</button>]}>{"Long ".repeat(50)}</BannerShell>)
    expect(screen.getByTestId("banner-message").className).toContain("truncate")
    const actions = screen.getByTestId("banner-actions").className
    expect(actions).toContain("whitespace-nowrap")
    expect(actions).toContain("flex-none")
  })

  it("only colours the icon when failed, and announces failures as alerts", () => {
    const { rerender } = render(<BannerShell icon="i">Archived</BannerShell>)
    expect(screen.getByRole("status")).toBeTruthy()
    rerender(<BannerShell icon="!" failed>Failed</BannerShell>)
    expect(screen.getByRole("alert").firstElementChild?.className).toContain("text-state-failed")
  })

  it("dismisses", () => {
    const onDismiss = vi.fn()
    render(<BannerShell onDismiss={onDismiss}>Note</BannerShell>)
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }))
    expect(onDismiss).toHaveBeenCalledOnce()
  })
})

describe("Callout tones collapse onto BannerShell styling", () => {
  it.each(["yellow", "green", "blue", "purple", "red"] as const)("%s has no tinted fill", (tone) => {
    const { container } = render(<Callout tone={tone}>Note</Callout>)
    expect((container.firstChild as HTMLElement).className).not.toMatch(/\bbg-|border-(yellow|green|blue|red|purple)/)
  })
})
