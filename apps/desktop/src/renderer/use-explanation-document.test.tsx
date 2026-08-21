// @vitest-environment jsdom

import type { ExplanationDocument, Session } from "@jingler/core"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, renderHook, waitFor } from "@testing-library/react"
import { StrictMode, type PropsWithChildren, type ReactElement } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { rpc } from "./rpc-client.js"
import {
  explanationQueryKey,
  installExplanationQueryBridge,
  useExplanationDocument,
  useExplanationSessions
} from "./use-explanation-document.js"

vi.mock("./rpc-client.js", () => ({
  rpc: {
    explanationCurrent: vi.fn(),
    explanationWatch: vi.fn()
  }
}))

const document = (sessionId: string, revision = 1): ExplanationDocument => ({
  id: `explanation-${sessionId}`,
  sessionId,
  producingChatId: "chat-1",
  revision,
  title: `Explanation ${revision}`,
  summary: "Summary",
  sections: [],
  updatedAt: "2026-08-21T10:00:00.000Z"
})

const session = (id: string): Session => ({ id } as Session)

let queryClient: QueryClient
let dispose: () => void
let stops: Map<string, ReturnType<typeof vi.fn>>
let listeners: Map<string, (value: ExplanationDocument | null) => void>

const wrapper = ({ children }: PropsWithChildren): ReactElement => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
)

const strictWrapper = ({ children }: PropsWithChildren): ReactElement => (
  <StrictMode><QueryClientProvider client={queryClient}>{children}</QueryClientProvider></StrictMode>
)

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } }
  })
  listeners = new Map()
  stops = new Map()
  vi.mocked(rpc.explanationCurrent).mockReset()
  vi.mocked(rpc.explanationWatch).mockReset().mockImplementation((sessionId, listener) => {
    const stop = vi.fn()
    listeners.set(sessionId, listener)
    stops.set(sessionId, stop)
    return stop
  })
  dispose = installExplanationQueryBridge(queryClient)
})

afterEach(() => {
  dispose()
  queryClient.clear()
})

describe("useExplanationDocument", () => {
  it("loads the current explanation and starts one live watcher", async () => {
    vi.mocked(rpc.explanationCurrent).mockResolvedValue(document("session-1"))
    const { result } = renderHook(() => useExplanationDocument("session-1"), { wrapper })

    await waitFor(() => expect(result.current.document?.revision).toBe(1))
    expect(rpc.explanationCurrent).toHaveBeenCalledWith("session-1")
    expect(rpc.explanationWatch).toHaveBeenCalledTimes(1)
  })

  it("keeps exactly one active watcher under StrictMode", async () => {
    let activeWatchers = 0
    vi.mocked(rpc.explanationCurrent).mockResolvedValue(document("session-1"))
    vi.mocked(rpc.explanationWatch).mockImplementation(() => {
      activeWatchers += 1
      return () => { activeWatchers -= 1 }
    })
    const { result, unmount } = renderHook(
      () => useExplanationDocument("session-1"),
      { wrapper: strictWrapper }
    )

    await waitFor(() => expect(result.current.document?.revision).toBe(1))
    expect(activeWatchers).toBe(1)
    unmount()
    expect(activeWatchers).toBe(0)
  })

  it("handles a synchronous watch baseline without opening a duplicate watcher", async () => {
    vi.mocked(rpc.explanationCurrent).mockResolvedValue(document("session-1"))
    vi.mocked(rpc.explanationWatch).mockImplementation((_sessionId, listener) => {
      listener(document("session-1", 2))
      return vi.fn()
    })
    const { result } = renderHook(() => useExplanationDocument("session-1"), { wrapper })

    await waitFor(() => expect(result.current.document?.revision).toBe(2))
    expect(rpc.explanationWatch).toHaveBeenCalledTimes(1)
  })

  it("updates the query cache from the live watcher", async () => {
    vi.mocked(rpc.explanationCurrent).mockResolvedValue(document("session-1"))
    const { result } = renderHook(() => useExplanationDocument("session-1"), { wrapper })
    await waitFor(() => expect(listeners.has("session-1")).toBe(true))

    act(() => listeners.get("session-1")?.(document("session-1", 2)))

    await waitFor(() => expect(result.current.document?.revision).toBe(2))
  })

  it("unsubscribes when the last observer unmounts", async () => {
    vi.mocked(rpc.explanationCurrent).mockResolvedValue(document("session-1"))
    const { unmount } = renderHook(() => useExplanationDocument("session-1"), { wrapper })
    await waitFor(() => expect(rpc.explanationWatch).toHaveBeenCalledTimes(1))
    const staleListener = listeners.get("session-1")

    unmount()
    act(() => staleListener?.(document("session-1", 2)))

    expect(stops.get("session-1")).toHaveBeenCalledTimes(1)
    expect(queryClient.getQueryData<ExplanationDocument>(explanationQueryKey("session-1"))?.revision).toBe(1)
  })

  it("surfaces current-read errors and retries through React Query", async () => {
    vi.mocked(rpc.explanationCurrent).mockRejectedValueOnce(new Error("read failed"))
    const { result } = renderHook(() => useExplanationDocument("session-1"), { wrapper })
    await waitFor(() => expect(result.current.error).toBe("read failed"))

    vi.mocked(rpc.explanationCurrent).mockResolvedValueOnce(document("session-1"))
    act(() => result.current.retry())

    await waitFor(() => expect(result.current.document?.revision).toBe(1))
  })
})

describe("useExplanationSessions", () => {
  it("unsubscribes sessions removed from the observed list", async () => {
    vi.mocked(rpc.explanationCurrent).mockResolvedValue(null)
    const { rerender } = renderHook(
      ({ ids }: { readonly ids: ReadonlyArray<string> }) =>
        useExplanationSessions(ids.map(session)),
      { wrapper, initialProps: { ids: ["a", "b"] } }
    )
    await waitFor(() => expect(listeners.size).toBe(2))
    const staleListener = listeners.get("b")

    rerender({ ids: ["a"] })
    act(() => staleListener?.(document("b")))

    expect(stops.get("b")).toHaveBeenCalledTimes(1)
    expect(queryClient.getQueryData(explanationQueryKey("b"))).toBeNull()
  })

  it("derives presence from shared queries and watch updates", async () => {
    vi.mocked(rpc.explanationCurrent).mockImplementation(async (sessionId) =>
      sessionId === "a" ? document("a") : null
    )
    const { result } = renderHook(
      () => useExplanationSessions([session("a"), session("b")]),
      { wrapper }
    )
    await waitFor(() => expect([...result.current]).toEqual(["a"]))

    act(() => listeners.get("b")?.(document("b")))

    await waitFor(() => expect([...result.current]).toEqual(["a", "b"]))
  })
})
