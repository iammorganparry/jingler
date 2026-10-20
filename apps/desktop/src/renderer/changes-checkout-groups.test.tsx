// @vitest-environment jsdom
import type { Session } from "@jingler/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ChangesExplorerPanel } from "./changes-review.js"
import { resetReviewStore, setReviewFilter } from "./review-store.js"
import { rpc } from "./rpc-client.js"

vi.mock("./rpc-client.js", () => ({
  rpc: { sessionsDiff: vi.fn(), githubFiles: vi.fn(), githubDiff: vi.fn(), githubPr: vi.fn() }
}))
vi.mock("./conversation-registry.js", () => {
  const snapshot = { context: { messages: [] } }
  const actor = { subscribe: () => ({ unsubscribe: () => {} }), getSnapshot: () => snapshot }
  return { getConversationActor: vi.fn(() => actor) }
})
vi.mock("./use-adversarial-review.js", () => ({
  useAdversarialReview: () => ({ review: null, sentFindingIds: new Set<string>(), sendFindingToAgent: () => {} })
}))

afterEach(() => {
  cleanup()
  resetReviewStore()
  vi.clearAllMocks()
})

const session = {
  id: "s1",
  repo: "org/api",
  branch: "feat/x",
  prNumber: null,
  worktreePath: "/wt/api",
  workspaceMode: "worktree",
  activeCheckoutId: "primary",
  checkouts: [
    { id: "primary", repo: "org/api", branch: "feat/x", prNumber: null, worktreePath: "/wt/api" },
    { id: "c2", repo: "org/web", branch: "feat/y", prNumber: null, worktreePath: "/wt/web" }
  ]
} as unknown as Session

describe("ChangesExplorerPanel", () => {
  it("groups changes by checkout and reads each checkout's own diff", async () => {
    setReviewFilter("s1", null, "local")
    vi.mocked(rpc.sessionsDiff).mockImplementation((async (_id: string, checkoutId?: string) => ({
      patch: "",
      files: [{ path: checkoutId === "c2" ? "web.ts" : "api.ts", added: 1, removed: 0, omitted: null }],
      lineLimit: 5000
    })) as never)
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ChangesExplorerPanel session={session} connected activePath={null} onOpenPath={() => {}} />
      </QueryClientProvider>
    )
    expect(screen.getByTestId("changes-checkout-primary").textContent).toContain("api · feat/x")
    expect(screen.getByTestId("changes-checkout-c2").textContent).toContain("web · feat/y")
    await waitFor(() => expect(rpc.sessionsDiff).toHaveBeenCalledWith("s1", "c2"))
    expect(rpc.sessionsDiff).toHaveBeenCalledWith("s1", "primary")
  })
})
