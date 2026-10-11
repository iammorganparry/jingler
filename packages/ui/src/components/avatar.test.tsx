import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Avatar, AvatarStack } from "./avatar.js"

afterEach(cleanup)

describe("Avatar", () => {
  it("renders the image when src loads", () => {
    const { container } = render(<Avatar initial="MP" src="https://x/a.png" label="Morgan Parry" size={20} />)
    const img = screen.getByAltText("Morgan Parry") as HTMLImageElement
    expect(img.style.width).toBe("20px")
    expect(container.querySelector('[data-avatar-kind="image"]')).not.toBeNull()
  })

  it("falls back to initials when the image fails", () => {
    render(<Avatar initial="MP" src="https://x/broken.png" />)
    fireEvent.error(screen.getByAltText("MP"))
    expect(screen.getByText("MP")).toBeDefined()
  })

  it("renders initials without a src and names them by label", () => {
    render(<Avatar initial="MP" label="Morgan Parry" size={24} />)
    expect(screen.getByLabelText("Morgan Parry").textContent).toBe("MP")
  })

  it("renders the mono Jingler mark for agent authors, ignoring src", () => {
    const { container } = render(<Avatar initial="J" agent src="https://x/a.png" />)
    expect(container.querySelector('[data-avatar-kind="agent"] svg')).not.toBeNull()
    expect(container.querySelector("img")).toBeNull()
  })

  it("shows a one-line count badge and hides it for zero", () => {
    const { rerender } = render(<Avatar initial="MP" count={3} />)
    const badge = screen.getByText("3")
    expect(badge.closest("[class*='whitespace-nowrap']")).not.toBeNull()
    rerender(<Avatar initial="MP" count={0} />)
    expect(screen.queryByText("0")).toBeNull()
  })

  it("is a focusable, named button when clickable", () => {
    const onClick = vi.fn()
    render(<Avatar initial="MP" label="Morgan Parry" onClick={onClick} />)
    const button = screen.getByRole("button", { name: "Morgan Parry" })
    button.focus()
    expect(document.activeElement).toBe(button)
    fireEvent.click(button)
    expect(onClick).toHaveBeenCalledOnce()
  })
})

describe("AvatarStack", () => {
  it("overlaps each avatar after the first by 6px in one non-wrapping row", () => {
    const { container } = render(
      <AvatarStack>
        <Avatar initial="A" />
        <Avatar initial="B" />
        <Avatar initial="C" />
      </AvatarStack>
    )
    const group = container.querySelector('[role="group"]') as HTMLElement
    expect(group.className).toContain("flex-nowrap")
    const slots = Array.from(group.children) as HTMLElement[]
    expect(slots.map((s) => s.style.marginLeft)).toEqual(["0px", "-6px", "-6px"])
  })

  it("collapses extras into +N", () => {
    render(
      <AvatarStack max={2}>
        <Avatar initial="A" />
        <Avatar initial="B" />
        <Avatar initial="C" />
        <Avatar initial="D" />
      </AvatarStack>
    )
    expect(screen.queryByText("C")).toBeNull()
    expect(screen.getByText("+2")).toBeDefined()
  })

  it("shows no overflow chip when everything fits", () => {
    render(
      <AvatarStack max={5}>
        <Avatar initial="A" />
      </AvatarStack>
    )
    expect(screen.queryByText(/^\+/)).toBeNull()
  })
})
