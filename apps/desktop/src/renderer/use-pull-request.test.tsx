// @vitest-environment jsdom
import { Session } from "@jingler/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { Schema } from "effect"
import type { ReactNode } from "react"
import { afterEach, expect, it, vi } from "vitest"
import { rpc } from "./rpc-client.js"
import { PR_REFRESH_MS, usePullRequest } from "./use-pull-request.js"

vi.mock("./rpc-client.js", () => ({
  rpc: {
    githubPr: vi.fn(),
    githubPrState: vi.fn(),
    githubMarkReady: vi.fn()
  }
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.useRealTimers()
})

it("never polls the PR state on a timer; Refresh and state changes reload the full view", async () => {
  vi.useFakeTimers()
  vi.mocked(rpc.githubPr).mockResolvedValue(null)
  vi.mocked(rpc.githubPrState)
    .mockResolvedValueOnce({ state: "open", checks: "running", updatedAt: "t1" })
    .mockResolvedValueOnce({ state: "open", checks: "running", updatedAt: "t1" })
    .mockResolvedValue({ state: "open", checks: "pass", updatedAt: "t2" })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )

  const session = Schema.decodeUnknownSync(Session)({
    id: "session-1",
    repo: "jingler",
    branch: "feat/refresh-pr",
    title: "Refresh PR",
    status: "idle",
    model: null,
    diff: { added: 0, removed: 0 },
    prNumber: 320,
    costUsd: 0,
    tokens: 0,
    updatedAt: "2026-09-29T00:00:00.000Z",
    chats: [{
      id: "chat-1",
      title: null,
      createdAt: "2026-09-29T00:00:00.000Z",
      updatedAt: "2026-09-29T00:00:00.000Z"
    }],
    activeChatId: "chat-1",
    worktreePath: "/tmp/session-1",
    baseBranch: "main",
    mode: "auto"
  })
  const { result } = renderHook(() => usePullRequest(session, { connected: true }), { wrapper })
  await act(async () => {})
  expect(rpc.githubPr).toHaveBeenCalledTimes(1)
  expect(rpc.githubPrState).toHaveBeenCalledTimes(1)

  // No timer: an open PR view spends no gh calls while it sits there.
  await act(async () => vi.advanceTimersByTimeAsync(PR_REFRESH_MS * 10))
  expect(rpc.githubPrState).toHaveBeenCalledTimes(1)

  // Refresh with unchanged state: the expensive full read is re-read once (the button asks for it)…
  await act(async () => { result.current.refresh() })
  await act(async () => vi.advanceTimersByTimeAsync(10))
  expect(rpc.githubPrState).toHaveBeenCalledTimes(2)
  expect(rpc.githubPr).toHaveBeenCalledTimes(2)

  // …and a state change (checks moved) triggers the reload on its own.
  await act(async () => { client.invalidateQueries({ queryKey: ["pr-state"] }) })
  await act(async () => vi.advanceTimersByTimeAsync(10))
  expect(rpc.githubPrState).toHaveBeenCalledTimes(3)
  // The reload is triggered from an effect after the new state lands; react-query
  // delivers that state on a setTimeout(0), which fake timers must advance.
  await act(async () => vi.advanceTimersByTimeAsync(10))
  expect(rpc.githubPr).toHaveBeenCalledTimes(3)
  client.clear()
})

it("flips a draft PR to open in the cache once markReady succeeds", async () => {
  vi.mocked(rpc.githubPr).mockResolvedValue({ number: 320, state: "draft", isDraft: true, mergeBlockers: [], timeline: [], reviewThreads: [] } as never)
  vi.mocked(rpc.githubMarkReady).mockResolvedValue(undefined)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  const session = { id: "session-1", prNumber: 320 } as never
  const { result } = renderHook(() => usePullRequest(session, { connected: true }), { wrapper })
  await waitFor(() => expect(result.current.pr?.state).toBe("draft"))
  await act(async () => result.current.markReady())
  await waitFor(() => expect(result.current.pr).toMatchObject({ state: "open", isDraft: false }))
  client.clear()
})
