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
    githubDetectPr: vi.fn(),
    githubMarkReady: vi.fn()
  }
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.useRealTimers()
})

it("refreshes the visible pull request every ten seconds", async () => {
  vi.useFakeTimers()
  vi.mocked(rpc.githubPr).mockResolvedValue(null)
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
  renderHook(() => usePullRequest(session, { connected: true, autoDetect: false }), { wrapper })
  await act(async () => {})
  expect(rpc.githubPr).toHaveBeenCalledTimes(1)

  await act(async () => vi.advanceTimersByTimeAsync(PR_REFRESH_MS))
  expect(rpc.githubPr).toHaveBeenCalledTimes(2)
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
  const { result } = renderHook(() => usePullRequest(session, { connected: true, autoDetect: false }), { wrapper })
  await waitFor(() => expect(result.current.pr?.state).toBe("draft"))
  await act(async () => result.current.markReady())
  await waitFor(() => expect(result.current.pr).toMatchObject({ state: "open", isDraft: false }))
  client.clear()
})
