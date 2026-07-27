import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import type { StreamEvent } from "@jingler/core"
import { Effect } from "effect"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AgentContext, SessionSpec, SteerTurn } from "./adapter.js"

/**
 * A turn with live sub-agents is not done.
 *
 * The SDK backgrounds every `Task` by default, so the main agent's `result` lands
 * while its sub-agents are still working — and every sub-agent runs inside that ONE
 * `query()` with ONE `AbortController`. So closing the input channel at that result
 * ended the query and killed all of them at once: the operator delegated five
 * agents, said one more thing to the chat, and watched every tab die.
 *
 * `turn-continuation.test.ts` pins the policy in isolation. These tests pin the loop
 * OBEYING it, which is a different claim: the emit ordering, the timer selection,
 * and the teardown are all in `runClaude`, not in the policy.
 *
 * The mock models the one behaviour that matters — the real query ends when its
 * streaming input closes — by draining `options.prompt` and finishing when it
 * returns. Without that, `live.finish()` would be unobservable and every test here
 * would pass whether or not the fix worked.
 */

/**
 * Yield-here-then-wait marker. A test that needs to act mid-stream (push a steer
 * while sub-agents are running) has to stop the harness at a known point — without
 * it, the script drains to the end and the channel is already closed by the time
 * the test gets a turn, which is a property of the test, not of the code.
 */
const PAUSE = Symbol("pause")

/** Messages the mocked harness will yield, in order. Set per test. */
let scripted: ReadonlyArray<SDKMessage | typeof PAUSE> = []
/** Released by the test to let the mock continue past a `PAUSE`. */
let release: () => void = () => {}
let released: Promise<void>
/** Messages the adapter pushed INTO the query (the steer channel). */
let pushed: SDKUserMessage[] = []
/** Set by the mock's `finally` — i.e. the iterator genuinely unwound. */
let iteratorUnwound = false
/** True once the adapter closed the input channel (`live.finish()`). */
let inputClosed = false
/** Scripted messages the mock never got to yield because the input closed first. */
let truncatedAt: number | null = null

/**
 * Let a `finish()` from the previous message reach the drain loop.
 *
 * Microtasks, not a timer, so this behaves identically under `vi.useFakeTimers()`.
 * A `for await` noticing its async generator has returned takes a few turns.
 */
const settleMicrotasks = async () => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
}
/** Resolved once the mocked query has yielded everything and is parked on input. */
let parked: Promise<void>

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: ({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => ({
    async *[Symbol.asyncIterator]() {
      // The real query ends when its input channel closes. Draining the live
      // iterable here is what makes `live.finish()` observable.
      const drained = (async () => {
        for await (const message of prompt) pushed.push(message)
        inputClosed = true
      })()
      try {
        for (const [index, message] of scripted.entries()) {
          if (message === PAUSE) {
            markParked()
            await released
            continue
          }
          // The real query ENDS when its streaming input closes. Yielding on past
          // that point is the difference between a mock that models the harness and
          // one that hides a premature `live.finish()`: the remaining script would
          // arrive from a process that, in production, no longer exists.
          await settleMicrotasks()
          if (inputClosed) {
            truncatedAt ??= index
            break
          }
          yield message
        }
        markParked()
        await drained
      } finally {
        iteratorUnwound = true
      }
    },
    interrupt: async () => {},
    setPermissionMode: async () => {}
    // NOTE: no `getContextUsage`, so `probeContextUsage` returns null and no
    // `Usage` event is emitted. Keeps these assertions about the seam only.
  })
}))

let markParked: () => void = () => {}

const spec = {
  cli: "claude",
  repo: "widget",
  branch: "b",
  cwd: "/tmp/wt",
  prompt: "delegate this",
  images: [],
  binPath: null,
  mode: "accept-edits",
  model: null,
  resumeId: null
} as unknown as SessionSpec

/** Collected events, plus the steer handle the run published. */
interface Harness {
  readonly events: ReadonlyArray<StreamEvent>
  readonly tags: ReadonlyArray<string>
  /** Null once the run retracted it — which must NOT happen at the held result. */
  steer: SteerTurn | null
  /** How many times the handle was registered/retracted, newest last. */
  readonly registrations: ReadonlyArray<"handle" | "null">
}

const harness = (): { ctx: AgentContext; state: Harness } => {
  const events: StreamEvent[] = []
  const registrations: Array<"handle" | "null"> = []
  const state: Harness = {
    events,
    get tags() {
      return events.map((event) => event._tag)
    },
    steer: null,
    registrations
  }
  const ctx: AgentContext = {
    emit: (event: StreamEvent) =>
      Effect.sync(() => {
        events.push(event)
      }),
    canUseTool: () => Effect.succeed("allow" as never),
    askQuestion: () => Effect.succeed([] as never),
    proposePlan: () => Effect.succeed({ _tag: "Reject" } as never),
    registerBackgroundStop: () => Effect.void,
    registerTurnSteer: (handler: SteerTurn | null) =>
      Effect.sync(() => {
        state.steer = handler
        registrations.push(handler === null ? "null" : "handle")
      })
  }
  return { ctx, state }
}

// ── SDK message fixtures ──────────────────────────────────────────────────────

const base = { session_id: "sdk-1", uuid: "u" }

const spawn = (id: string, parent?: string): SDKMessage =>
  ({
    ...base,
    type: "assistant",
    ...(parent === undefined ? {} : { parent_tool_use_id: parent }),
    message: {
      content: [
        { type: "tool_use", id, name: "Task", input: { subagent_type: "Explore", description: `work ${id}` } }
      ]
    }
  }) as unknown as SDKMessage

/** The ~150ms "Async agent launched successfully" ACK. Must NOT settle the tab. */
const launchAck = (id: string, isError = false): SDKMessage =>
  ({
    ...base,
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: id,
          is_error: isError,
          content: isError ? "spawn failed" : "Async agent launched successfully"
        }
      ]
    }
  }) as unknown as SDKMessage

/**
 * The harness's START bookend, emitted for EVERY Task — foreground or backgrounded.
 *
 * Present in these scripts because its ABSENCE is now meaningful: a Task the
 * harness never started is one whose `task_notification` will never arrive
 * either, and the adapter settles that Task on its own `tool_result` rather than
 * holding the turn for the full linger cap (see "settles a Task the harness never
 * bookended"). Leaving it out of a script that means to exercise the normal path
 * would silently take the fallback instead.
 */
const started = (id: string): SDKMessage =>
  ({
    ...base,
    type: "system",
    subtype: "task_started",
    task_id: `bg_${id}`,
    tool_use_id: id,
    description: `work ${id}`,
    subagent_type: "Explore"
  }) as unknown as SDKMessage

/** The authoritative sub-agent completion bookend. */
const notify = (id: string, status = "completed"): SDKMessage =>
  ({ ...base, type: "system", subtype: "task_notification", task_id: `bg_${id}`, tool_use_id: id, status }) as unknown as SDKMessage

const progress = (id: string): SDKMessage =>
  ({ ...base, type: "system", subtype: "task_progress", task_id: `bg_${id}`, tool_use_id: id }) as unknown as SDKMessage

const result = (ok = true): SDKMessage =>
  ({
    ...base,
    type: "result",
    subtype: ok ? "success" : "error_during_execution",
    is_error: false,
    result: "ok",
    total_cost_usd: 0.01,
    usage: { input_tokens: 1, output_tokens: 1 },
    ...(ok ? {} : { errors: ["the harness fell over"] })
  }) as unknown as SDKMessage

/**
 * Run the scripted sequence to completion.
 *
 * `during` runs at the script's `PAUSE` (or, with no PAUSE, once everything has
 * been yielded) and the script continues when it returns.
 */
const run = async (
  messages: ReadonlyArray<SDKMessage | typeof PAUSE>,
  during?: (state: Harness) => Promise<void>
) => {
  scripted = messages
  const { ctx, state } = harness()
  const { runClaude } = await import("./claude-adapter.js")
  const finished = Effect.runPromise(runClaude("s1", spec, ctx, new Map()))
  if (during !== undefined) {
    await parked
    await during(state)
  }
  release()
  await finished
  return state
}

beforeEach(() => {
  pushed = []
  iteratorUnwound = false
  inputClosed = false
  truncatedAt = null
  parked = new Promise<void>((resolve) => {
    markParked = resolve
  })
  released = new Promise<void>((resolve) => {
    release = resolve
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe("a turn with live sub-agents", () => {
  it("withholds Done until the sub-agent's task_notification arrives", async () => {
    const state = await run([
      spawn("task_1"),
      started("task_1"),
      launchAck("task_1"),
      result(), // the main agent stops talking — the old bug closed the query HERE
      progress("task_1"),
      notify("task_1")
    ])

    expect(state.tags.filter((tag) => tag === "Done")).toHaveLength(1)
    expect(state.tags.indexOf("Done")).toBeGreaterThan(state.tags.indexOf("SubagentEnded"))
    expect(iteratorUnwound).toBe(true)
  })

  it("keeps the steer handle registered across the held result", async () => {
    // The whole point of holding the turn open: the operator's next message goes
    // into the SAME query, so the sub-agents keep running. A retracted handle sends
    // the renderer down the stop-and-replay path, which aborts everything.
    const state = await run([spawn("task_1"), started("task_1"), launchAck("task_1"), result(), notify("task_1")])
    // Registered once at the start, retracted once in the run's `finally` — never
    // in between, or the message would have had nowhere to go.
    expect(state.registrations).toStrictEqual(["handle", "null"])
  })

  it("waits for the LAST of several sub-agents, not the first", async () => {
    const state = await run([
      spawn("task_1"),
      spawn("task_2"),
      started("task_1"),
      started("task_2"),
      launchAck("task_1"),
      launchAck("task_2"),
      result(),
      notify("task_1"),
      progress("task_2"),
      notify("task_2")
    ])

    const done = state.tags.indexOf("Done")
    const ended = state.tags.reduce<number[]>((at, tag, i) => (tag === "SubagentEnded" ? [...at, i] : at), [])
    expect(ended).toHaveLength(2)
    expect(done).toBeGreaterThan(ended[1]!)
  })

  it("counts a NESTED sub-agent, so a deep tree still holds the turn", async () => {
    const state = await run([
      spawn("task_1"),
      spawn("task_2", "task_1"), // spawned BY task_1
      started("task_1"),
      started("task_2"),
      launchAck("task_1"),
      result(),
      notify("task_1"), // the parent finishes first
      notify("task_2")
    ])

    const done = state.tags.indexOf("Done")
    expect(done).toBe(state.tags.length - 1)
    expect(state.events.filter((e) => e._tag === "SubagentEnded")).toHaveLength(2)
  })

  it("still emits the real Done when a notification never arrives (linger cap)", async () => {
    vi.useFakeTimers()
    scripted = [spawn("task_1"), started("task_1"), launchAck("task_1"), result()]
    const { ctx, state } = harness()
    const { runClaude } = await import("./claude-adapter.js")
    const finished = Effect.runPromise(runClaude("s1", spec, ctx, new Map()))

    await vi.advanceTimersByTimeAsync(0)
    await parked
    // Held open, as it should be — the sub-agent has not bookended.
    expect(state.tags).not.toContain("Done")

    // Past the leak guard. Crucially the turn settles with its REAL `Done`, not
    // the "ended without responding" fallback: the turn did complete.
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1)
    await finished

    expect(state.tags.filter((tag) => tag === "Done")).toHaveLength(1)
    expect(state.tags).not.toContain("Failed")
  })

  it("settles a Task the harness never bookended, instead of hanging for the cap", async () => {
    // `spec.binPath` lets the operator point at any `claude` install, and a build
    // that predates the task bookends emits no `task_started` and no
    // `task_notification` — its Tasks are plain synchronous tool calls whose
    // `tool_result` carries the real output, not a launch ACK. Without this
    // fallback the `SubagentStarted` is never retracted, so EVERY delegating turn
    // reads as running for the full ten-minute linger cap after the work is done.
    //
    // Note the missing `started("task_1")`: its absence is the whole test.
    vi.useFakeTimers()
    scripted = [spawn("task_1"), launchAck("task_1"), result()]
    const { ctx, state } = harness()
    const { runClaude } = await import("./claude-adapter.js")
    const finished = Effect.runPromise(runClaude("s1", spec, ctx, new Map()))

    // No timers advanced: the turn settles on the tool_result itself.
    await vi.advanceTimersByTimeAsync(0)
    await finished

    expect(state.tags.filter((tag) => tag === "Done")).toHaveLength(1)
    expect(state.tags).toContain("SubagentEnded")
    expect(state.events.find((e) => e._tag === "SubagentEnded")).toMatchObject({ id: "task_1", status: "done" })
    expect(state.tags).not.toContain("Failed")
  })

  it("does not wait for a Task that failed to launch", async () => {
    // An errored tool_result is the leak guard: no `task_notification` is coming,
    // so holding for ten minutes would be ten minutes of a chat that looks stuck.
    const state = await run([spawn("task_1"), started("task_1"), launchAck("task_1", true), result()])

    expect(state.tags.filter((tag) => tag === "Done")).toHaveLength(1)
    expect(state.tags).not.toContain("SubagentEnded")
  })

  it("closes immediately on a Failed, whatever is outstanding", async () => {
    const state = await run([spawn("task_1"), started("task_1"), launchAck("task_1"), result(false)])

    expect(state.tags.filter((tag) => tag === "Failed")).toHaveLength(1)
    expect(state.tags).not.toContain("Done")
    expect(iteratorUnwound).toBe(true)
  })

  it("takes a steer pushed while sub-agents were running", async () => {
    const state = await run(
      // Paused AFTER the main agent's result, while task_1 is still working — the
      // exact moment the operator was losing their sub-agents.
      [spawn("task_1"), started("task_1"), launchAck("task_1"), result(), PAUSE, notify("task_1"), result()],
      async (live) => {
        // The assertion is that talking here does NOT kill anything: the handle is
        // still live, so the message goes into the SAME query as the sub-agents.
        expect(live.steer).not.toBeNull()
        expect(await live.steer!("also check the tests", [])).toBe("accepted")
      }
    )

    expect(pushed.map((message) => message.message.content)).toContain("also check the tests")
    expect(state.tags.filter((tag) => tag === "Done")).toHaveLength(1)
    expect(state.tags.indexOf("Done")).toBeGreaterThan(state.tags.indexOf("SubagentEnded"))
    // The continuation the hold exists for must actually be reached. The channel
    // closing before the script ran out means the operator's message went into a
    // query that was already shutting down — accepted, and never answered.
    expect(truncatedAt).toBeNull()
  })

  it("holds the channel open for a steer taken during a sub-agent hold", async () => {
    // The narrowest form of the bug, and the one a `hasUnread()` check cannot see:
    // the SDK pulls a pushed message out within a microtask, so by the foot of the
    // loop the channel looks EMPTY whether or not the CLI has acted on it. If the
    // last `task_notification` then lands before the continuation's `result`, the
    // policy sees no steer and no sub-agents and closes at 0ms — cutting the very
    // turn the push was meant to open.
    const state = await run(
      [spawn("task_1"), started("task_1"), launchAck("task_1"), result(), PAUSE, notify("task_1"), result()],
      async (live) => {
        expect(await live.steer!("and the theme tokens", [])).toBe("accepted")
      }
    )

    // Nothing was cut, and the turn settled exactly once.
    expect(truncatedAt).toBeNull()
    expect(state.tags.filter((tag) => tag === "Done")).toHaveLength(1)
  })

  it("remembers the steer across the messages between it and the last bookend", async () => {
    // The same bug one message further out, and the one a "remember the last
    // verdict" fix still gets wrong: the steer is noticed while TWO sub-agents are
    // live, so the verdict that message is `subagent-work`. If that overwrites the
    // memory, the steer is forgotten — and when the second bookend lands the policy
    // sees no steer and no sub-agents and closes at 0ms.
    //
    // The steer must be remembered as its own fact, not inferred from whichever
    // reason happened to pick the timer.
    const state = await run(
      [
        spawn("task_1"),
        spawn("task_2"),
        started("task_1"),
        started("task_2"),
        launchAck("task_1"),
        result(),
        PAUSE,
        progress("task_1"), // a message between the steer and the bookends
        notify("task_1"),
        notify("task_2"), // sub-agents drain HERE, long after the steer was noticed
        result()
      ],
      async (live) => {
        expect(await live.steer!("and the theme tokens", [])).toBe("accepted")
      }
    )

    expect(truncatedAt).toBeNull()
    expect(pushed.map((message) => message.message.content)).toContain("and the theme tokens")
    expect(state.tags.filter((tag) => tag === "Done")).toHaveLength(1)
  })
})

describe("a turn with no sub-agents", () => {
  it("closes at its result exactly as before", async () => {
    // The regression guard for undelegated work: a synchronous Task's notification
    // lands before its tool_result, so the set is empty by the result and nothing
    // about this path changes.
    const state = await run([result()])

    expect(state.tags).toStrictEqual(["Done"])
    expect(iteratorUnwound).toBe(true)
  })
})
