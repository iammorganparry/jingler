import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { ConversationView } from "./conversation-view.js"

afterEach(cleanup)

describe("ConversationView Fleet integration", () => {
  it("renders Fleet inside the composer's shared chrome", () => {
    render(
      <ConversationView
        messages={[]}
        mode="accept-edits"
        fleetSlot={<section data-testid="fleet">Fleet</section>}
      />
    )

    expect(screen.getByTestId("composer").contains(screen.getByTestId("fleet")))
      .toBe(true)
  })
})
