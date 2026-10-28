// @vitest-environment jsdom
import type { Session } from "@jingler/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { CheckoutHeader } from "./checkout-header.js"
import { rpc } from "./rpc-client.js"

vi.mock("./rpc-client.js", () => ({ rpc: { githubPrState: vi.fn(), sessionsSwitchCheckout: vi.fn() } }))
vi.mock("./session-updates.js", () => ({ publishSessionUpdate: vi.fn() }))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const renderHeader = (session: Session) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <CheckoutHeader session={session} />
    </QueryClientProvider>
  )

describe("CheckoutHeader", () => {
  it("renders nothing and fetches nothing for a legacy single-checkout session", () => {
    renderHeader({ id: "s1", repo: "org/api", branch: "main", prNumber: 5 } as unknown as Session)
    expect(screen.queryByTestId("checkout-switcher")).toBeNull()
    expect(rpc.githubPrState).not.toHaveBeenCalled()
  })

  it("shows the active repo and one PR chip per linked checkout", async () => {
    vi.mocked(rpc.githubPrState).mockResolvedValue({ state: "open", checks: "pass" } as never)
    renderHeader({
      id: "s1",
      repo: "org/api",
      branch: "feat/x",
      prNumber: 12,
      activeCheckoutId: "primary",
      checkouts: [
        { id: "primary", repo: "org/api", branch: "feat/x", prNumber: 12 },
        { id: "c2", repo: "org/web", branch: "feat/y", prNumber: 31 }
      ]
    } as unknown as Session)
    expect(screen.getByText("api · feat/x")).toBeDefined()
    expect(screen.getByTestId("checkout-pr-primary").textContent).toContain("#12")
    expect(screen.getByTestId("checkout-pr-c2").textContent).toContain("#31")
    await waitFor(() => expect(rpc.githubPrState).toHaveBeenCalledWith("s1", undefined, "c2"))
  })
})
