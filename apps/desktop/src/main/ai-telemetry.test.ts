import { Effect, Stream } from "effect"
import { describe, expect, it, vi } from "vitest"
import type { StreamEvent } from "@jingler/core"

vi.mock("electron", () => ({ app: { getPath: () => "/tmp" } }))

const { newTurn, recordEvent, turnEvents, sendTurn, observeTurn } = await import("./ai-telemetry.js")

const events: StreamEvent[] = [
  { _tag: "Started", sessionId: "pi-1", model: "claude-opus" },
  { _tag: "Assistant", text: "Hello " },
  { _tag: "ToolStart", id: "t1", name: "Bash", target: "ls", intent: "List files" },
  { _tag: "Assistant", text: "sub-agent chatter", agentId: "worker" },
  { _tag: "ToolEnd", id: "t1", status: "error", meta: null, diff: null, preview: null, output: "x".repeat(5000) },
  { _tag: "Assistant", text: "world" },
  { _tag: "Usage", tokens: 1200, window: 200000 },
  { _tag: "Done", costUsd: 0.02, tokens: 1500 }
]

const finished = () => {
  const turn = newTurn("s1", "c1", "do the thing", 1000)
  for (const [i, event] of events.entries()) recordEvent(turn, event, 1000 + (i + 1) * 100)
  return turn
}

const deps = (overrides: Partial<Parameters<typeof sendTurn>[1]> = {}) => {
  const fetch = vi.fn(async () => new Response("{}"))
  return { fetch, deps: { key: "phc_k", host: "https://us.i.posthog.com", enabled: async () => true, distinctId: async () => "install-1", fetch: fetch as unknown as typeof globalThis.fetch, ...overrides } }
}

describe("turnEvents", () => {
  it("emits a trace, a generation and a span per tool, all on one trace and chat session", () => {
    const [trace, generation, span, ...rest] = turnEvents(finished(), "install-1")
    expect(rest).toHaveLength(0)
    expect(trace?.event).toBe("$ai_trace")
    expect(generation?.properties).toMatchObject({
      $ai_model: "claude-opus",
      $ai_output_choices: [{ role: "assistant", content: "Hello world" }],
      $ai_total_cost_usd: 0.02,
      context_tokens: 1200,
      context_window: 200000,
      $ai_is_error: false
    })
    expect(span?.properties).toMatchObject({ $ai_span_name: "Bash", $ai_parent_id: trace?.properties.$ai_trace_id, $ai_is_error: true, $ai_latency: 0.2 })
    for (const event of [trace, generation, span]) expect(event?.properties.$ai_session_id).toBe("c1")
  })

  it("clips long tool output", () => {
    const span = turnEvents(finished(), "x")[2]
    if (!span) throw new Error("missing tool span")
    const output = (span.properties.$ai_output_state as { output: string }).output
    expect(output.length).toBeLessThan(4100)
    expect(output.endsWith("[truncated]")).toBe(true)
  })

  it("marks a turn that never completed as an error", () => {
    const [trace] = turnEvents(newTurn("s", "c", "p"), "x")
    expect(trace?.properties.$ai_is_error).toBe(true)
  })
})

describe("sendTurn", () => {
  it("posts one batch with our key", async () => {
    const { fetch, deps: d } = deps()
    await sendTurn(finished(), d)
    expect(fetch).toHaveBeenCalledOnce()
    const [url, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit]
    expect(String(url)).toBe("https://us.i.posthog.com/batch/")
    expect(JSON.parse(String(init.body))).toMatchObject({ api_key: "phc_k", batch: [{ event: "$ai_trace" }, {}, {}] })
  })

  it("sends nothing unless opted in and built with a key", async () => {
    const off = deps({ enabled: async () => false })
    await sendTurn(finished(), off.deps)
    const noKey = deps({ key: undefined })
    await sendTurn(finished(), noKey.deps)
    expect(off.fetch).not.toHaveBeenCalled()
    expect(noKey.fetch).not.toHaveBeenCalled()
  })

  it("swallows network failures", async () => {
    const { deps: d } = deps({ fetch: (async () => { throw new Error("offline") }) as unknown as typeof fetch })
    await expect(sendTurn(finished(), d)).resolves.toBeUndefined()
  })
})

describe("observeTurn", () => {
  it("passes events through unchanged and sends when the stream ends", async () => {
    const { fetch, deps: d } = deps()
    const seen = await Effect.runPromise(Stream.runCollect(observeTurn("s1", "c1", "p", Stream.fromIterable(events), d)))
    expect([...seen]).toEqual(events)
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
  })

  it("never records a turn that started while opted out, even if opted in mid-turn", async () => {
    let enabled = false
    const { fetch, deps: d } = deps({ enabled: async () => enabled })
    const late = Stream.fromIterable(events).pipe(Stream.tap(() => Effect.sync(() => { enabled = true })))
    await Effect.runPromise(Stream.runCollect(observeTurn("s1", "c1", "p", late, d)))
    await new Promise((r) => setTimeout(r, 10))
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe("collection bounds and status", () => {
  it("caps the reply while recording, not only when serializing", () => {
    const turn = newTurn("s", "c", "p")
    for (let i = 0; i < 100; i++) recordEvent(turn, { _tag: "Assistant", text: "y".repeat(1000) })
    expect(turn.reply.length).toBeLessThanOrEqual(4001)
  })

  it("marks an interrupted tool as an error", () => {
    const turn = newTurn("s", "c", "p")
    recordEvent(turn, { _tag: "ToolStart", id: "t", name: "Bash", target: null })
    expect(turnEvents(turn, "x")[2]?.properties.$ai_is_error).toBe(true)
  })

  it("logs a rejected batch instead of treating it as sent", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const { deps: d } = deps({ fetch: (async () => new Response("bad", { status: 400 })) as unknown as typeof fetch })
    await sendTurn(finished(), d)
    expect(error).toHaveBeenCalledWith("AI telemetry rejected", 400)
    error.mockRestore()
  })
})
