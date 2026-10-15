import { cleanup, render, screen } from "@testing-library/react"
import type { SessionCheckout } from "@jingler/core"
import { afterEach, describe, expect, it } from "vitest"
import { CheckoutSwitcher, checkoutLabel } from "./checkout-switcher.js"

afterEach(cleanup)

const api: SessionCheckout = { id: "primary", repo: "org/api", branch: "feat/x", prNumber: 12 }
const web: SessionCheckout = { id: "c2", repo: "org/web", branch: "feat/y", prNumber: null }

describe("CheckoutSwitcher", () => {
  it("renders nothing for a legacy single-checkout session", () => {
    render(<CheckoutSwitcher checkouts={[api]} activeCheckoutId="primary" />)
    expect(screen.queryByTestId("checkout-switcher")).toBeNull()
  })

  it("shows the active repo · branch and a PR chip only for checkouts with a PR", () => {
    render(<CheckoutSwitcher checkouts={[api, web]} activeCheckoutId="c2" prStates={{ primary: { state: "open", checks: "pass" } }} />)
    expect(screen.getByText("web · feat/y")).toBeDefined()
    expect(screen.getByTestId("checkout-pr-primary").textContent).toContain("#12")
    expect(screen.queryByTestId("checkout-pr-c2")).toBeNull()
  })

  it("labels a checkout by its repo name and branch", () => {
    expect(checkoutLabel(api)).toBe("api · feat/x")
  })
})
