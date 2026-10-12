import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle, DrawerTrigger } from "./drawer.js"

afterEach(cleanup)

const Harness = () => (
  <Drawer>
    <DrawerTrigger>Open usage</DrawerTrigger>
    <DrawerContent>
      <DrawerTitle>Run details</DrawerTitle>
      <DrawerDescription>Slowest runs</DrawerDescription>
    </DrawerContent>
  </Drawer>
)

describe("Drawer", () => {
  it("opens over a full-window scrim, closes on Esc and returns focus to the trigger", async () => {
    render(<Harness />)
    const trigger = screen.getByRole("button", { name: "Open usage" })
    trigger.focus()
    fireEvent.click(trigger)
    const dialog = await screen.findByRole("dialog", { name: "Run details" })
    expect(dialog.className).toContain("w-[480px]")
    expect(screen.getByTestId("drawer-scrim").className).toContain("inset-0")
    fireEvent.keyDown(dialog, { key: "Escape" })
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(document.activeElement).toBe(trigger)
  })
})
