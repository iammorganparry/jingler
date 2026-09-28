// @vitest-environment jsdom
import type { Session } from "@jingler/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, renderHook, waitFor } from "@testing-library/react"
import type { PropsWithChildren, ReactElement } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useChangesReview } from "./changes-review.js"
import { getConversationActor } from "./conversation-registry.js"
import { resetReviewStore, setReviewFilter } from "./review-store.js"
import { rpc } from "./rpc-client.js"

vi.mock("./rpc-client.js", () => ({
  rpc: {
    sessionsDiff: vi.fn(),
    githubFiles: vi.fn(),
    githubDiff: vi.fn(),
    githubPr: vi.fn(),
    githubSubmitReview: vi.fn()
  }
}))
vi.mock("./conversation-registry.js", () => ({ getConversationActor: vi.fn() }))
vi.mock("./use-adversarial-review.js", () => ({
  useAdversarialReview: () => ({
    review: null,
    sentFindingIds: new Set<string>(),
    sendFindingToAgent: () => {}
  })
}))

const path = "src/auth/session.ts"
const patch = [
  `diff --git a/${path} b/${path}`,
  `--- a/${path}`,
  `+++ b/${path}`,
  "@@ -31,4 +31,6 @@",
  " export async function session(req, next) {",
  "   const s = req.session",
  "-  if (!s.token) return next()",
  "+  if (isExpired(s.token)) {",
  "+    await refresh(s)",
  "+  }",
  "   return next()",
  ""
].join("\n")

const session = {
  id: "s1",
  title: "Refresh expired sessions",
  prNumber: null,
  worktreePath: "/repo/.worktrees/s1",
  workspaceMode: "worktree"
} as unknown as Session

let queryClient: QueryClient
let send: ReturnType<typeof vi.fn>

const wrapper = ({ children }: PropsWithChildren): ReactElement => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
)

const renderReview = async () => {
  // Reviewing is what turns the diff queries on.
  setReviewFilter(session.id, session.prNumber, "local")
  const hook = renderHook(() => useChangesReview(session, true), { wrapper })
  // The uncommitted diff is what comments are written against.
  await waitFor(() => expect(hook.result.current.review.files).toHaveLength(1))
  return hook
}

const sentEvent = () => send.mock.calls[0]?.[0] as {
  readonly type: string
  readonly text: string
  readonly agentContext?: string
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  send = vi.fn()
  vi.mocked(getConversationActor).mockReturnValue({ send } as never)
  vi.mocked(rpc.sessionsDiff).mockResolvedValue({
    patch,
    files: [{ path, added: 3, removed: 1, omitted: null }],
    lineLimit: 5000
  } as never)
  vi.mocked(rpc.githubFiles).mockRejectedValue(new Error("no PR"))
  vi.mocked(rpc.githubDiff).mockRejectedValue(new Error("no PR"))
  vi.mocked(rpc.githubSubmitReview).mockResolvedValue(undefined as never)
})

afterEach(() => {
  resetReviewStore()
  vi.clearAllMocks()
})

describe("review data fetching", () => {
  it("fetches nothing for a session nobody is reviewing", async () => {
    const { result } = renderHook(() => useChangesReview(session, true), { wrapper })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(result.current.review.files).toHaveLength(0)
    expect(rpc.sessionsDiff).not.toHaveBeenCalled()
    expect(rpc.githubPr).not.toHaveBeenCalled()
    expect(rpc.githubFiles).not.toHaveBeenCalled()
  })

  it("reads PR threads on their own key, never the Pull Request tab's", async () => {
    const prSession = { ...session, prNumber: 7 } as Session
    vi.mocked(rpc.githubPr).mockResolvedValue({ reviewThreads: [] } as never)
    setReviewFilter(prSession.id, 7, "pr")
    renderHook(() => useChangesReview(prSession, true), { wrapper })
    await waitFor(() => expect(rpc.githubPr).toHaveBeenCalled())
    // The PR tab's key carries its detect-and-relink queryFn; if this read
    // filled it, the tab would reuse it and never notice a replacement PR.
    expect(queryClient.getQueryData(["github", "pr", prSession.id, 7])).toBeUndefined()
  })
})

describe("sending review comments to the agent", () => {
  it("Send to agent sends one comment with the referenced lines' code", async () => {
    const { result } = await renderReview()

    act(() =>
      result.current.sendComment({ path, line: 33, endLine: 34, body: "Extract a helper." })
    )

    expect(send).toHaveBeenCalledOnce()
    const event = sentEvent()
    expect(event.type).toBe("SEND")
    expect(event.text).toContain(`\`${path}\` L33-34`)
    expect(event.text).toContain("Extract a helper.")
    expect(event.agentContext).toContain("<repository-code-references>")
    expect(event.agentContext).toContain(`Path: ${JSON.stringify(path)}`)
    expect(event.agentContext).toContain("Lines: 33-34 (inclusive)")
    expect(event.agentContext).toContain("if (isExpired(s.token)) {")
    expect(event.agentContext).toContain("await refresh(s)")
    // Sending is immediate: nothing is collected for the review tray.
    expect(result.current.review.drafts).toHaveLength(0)
  })

  it("Send N to agent sends every draft with each one's code, then clears the tray", async () => {
    const { result } = await renderReview()
    act(() => {
      result.current.review.addDraft({ path, line: 33, endLine: null, body: "Why inline?", routeToAgent: true })
      result.current.review.addDraft({ path, line: 36, endLine: null, body: "Early return?", routeToAgent: true })
    })

    act(() => result.current.review.finishReview("send_to_agent"))

    expect(send).toHaveBeenCalledOnce()
    const event = sentEvent()
    expect(event.text).toContain(`${path} L33: Why inline?`)
    expect(event.text).toContain(`${path} L36: Early return?`)
    expect(event.agentContext).toContain("Lines: 33 (inclusive)")
    expect(event.agentContext).toContain("if (isExpired(s.token)) {")
    expect(event.agentContext).toContain("Lines: 36 (inclusive)")
    expect(event.agentContext).toContain("return next()")
    expect(result.current.review.drafts).toHaveLength(0)
  })

  it("still sends a comment whose lines the diff can't supply, without a reference", async () => {
    const { result } = await renderReview()

    act(() => result.current.sendComment({ path, line: 90, endLine: null, body: "Also here." }))

    const event = sentEvent()
    expect(event.text).toContain(`\`${path}\` L90`)
    expect(event.agentContext).toBe("")
  })

  it("Comment only posts to GitHub and never messages the agent", async () => {
    const { result } = await renderReview()
    act(() =>
      result.current.review.addDraft({ path, line: 33, endLine: 34, body: "Nit.", routeToAgent: false })
    )

    act(() => result.current.review.finishReview("comment_only"))

    expect(send).not.toHaveBeenCalled()
    expect(rpc.githubSubmitReview).toHaveBeenCalledWith("s1", [
      { path, line: 34, startLine: 33, body: "Nit." }
    ])
  })
})
