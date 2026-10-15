// @vitest-environment jsdom
import type { Session } from "@jingler/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { CheckoutChecks } from "./checkout-checks.js"
import { rpc } from "./rpc-client.js"

vi.mock("./rpc-client.js", () => ({ rpc: { githubPr: vi.fn() } }))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const multi = {
  id: "s1",
  repo: "org/api",
  branch: "feat/x",
  prNumber: 12,
  activeCheckoutId: "primary",
  checkouts: [
    { id: "primary", repo: "org/api", branch: "feat/x", prNumber: 12 },
    { id: "c2", repo: "org/web", branch: "feat/y", prNumber: 31 },
    { id: "c3", repo: "org/docs", branch: "feat/z", prNumber: null }
  ]
} as unknown as Session

const renderChecks = (session: Session) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <CheckoutChecks session={session} />
    </QueryClientProvider>
  )

describe("CheckoutChecks", () => {
  it("renders nothing for a legacy single-checkout session", () => {
    renderChecks({ id: "s1", repo: "org/api", branch: "main", prNumber: 5 } as unknown as Session)
    expect(screen.queryByTestId("checkout-checks")).toBeNull()
    expect(rpc.githubPr).not.toHaveBeenCalled()
  })

  it("groups checks under each checkout that has a PR", async () => {
    vi.mocked(rpc.githubPr).mockImplementation(async (_id, checkoutId) =>
      ({ checks: [{ name: checkoutId === "c2" ? "web-ci" : "api-ci", status: "pass", detailsUrl: null, durationMs: null }] }) as never
    )
    renderChecks(multi)
    await waitFor(() => expect(screen.getByText("web-ci")).toBeDefined())
    expect(rpc.githubPr).toHaveBeenCalledWith("s1", "primary")
    expect(rpc.githubPr).toHaveBeenCalledWith("s1", "c2")
    expect(screen.getByTestId("checks-checkout-primary").textContent).toContain("api-ci")
    expect(screen.queryByTestId("checks-checkout-c3")).toBeNull()
  })
})
