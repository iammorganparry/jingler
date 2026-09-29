// @vitest-environment jsdom
import { Session } from "@jingler/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, renderHook } from "@testing-library/react"
import { Schema } from "effect"
import type { ReactNode } from "react"
import { afterEach, expect, it, vi } from "vitest"
import { rpc } from "./rpc-client.js"
import { PR_REFRESH_MS, usePullRequest } from "./use-pull-request.js"

vi.mock("./rpc-client.js", () => ({
  rpc: {
    githubPr: vi.fn(),
    githubDetectPr: vi.fn()
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
