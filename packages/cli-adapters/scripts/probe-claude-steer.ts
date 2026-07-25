#!/usr/bin/env node
/**
 * Does a message pushed into a LIVE Claude turn actually arrive?
 *
 * The queue's auto-flush rests on one claim about the real harness: with the SDK's
 * streaming-input form, a user message pushed while a turn is running is delivered
 * at the next tool boundary and answered in the SAME turn. Unit tests can only
 * check our side of that (`makeLiveInput`), and the e2e suite runs the scripted
 * stub — so this probe is the only thing that checks the claim against the CLI.
 *
 * It spawns the operator's real `claude`, so it is a manual tool, never CI:
 *
 *   pnpm --filter @starbase/cli-adapters probe:claude-steer
 *
 * WHAT IT FOUND (and what the adapter now assumes): the CLI absorbs the pushed
 * message into the running turn and emits exactly ONE `result`. The first version
 * of the adapter assumed a second turn and withheld the first `Done` waiting for
 * it — which would have hung every steered Claude turn until a timeout and then
 * reported a failure for a run that answered fine.
 *
 * Exit 0 = the steered word was answered, within a single `result`. Exit 2 = not.
 */
import { makeLiveInput } from "../src/claude-adapter.js"
import type { SessionSpec } from "../src/adapter.js"

const STEER_WORD = "PINEAPPLE"
const TIMEOUT_MS = 180_000
/** Push as the turn's `result` is handled, not mid-turn — the risky window. */
const atResult = process.argv.includes("--at-result")
/** Let the SDK drain the push before deciding, so `hasUnread()` reads false. */
const drainFirst = process.argv.includes("--drain-first")

const spec = {
  cli: "claude",
  repo: "",
  branch: "",
  cwd: process.cwd(),
  // A couple of cheap tool calls, so there IS a boundary to be delivered at.
  prompt:
    "Run `echo one`, then `echo two`, then `echo three` with the Bash tool, one at a time. Reply DONE when finished.",
  images: [],
  binPath: null,
  mode: "accept-edits",
  model: null,
  resumeId: null
} as unknown as SessionSpec

const main = async (): Promise<number> => {
  const { query } = await import("@anthropic-ai/claude-agent-sdk")
  const live = makeLiveInput(spec, undefined)
  const iterator = query({
    prompt: live.iterable,
    options: {
      cwd: process.cwd(),
      permissionMode: "acceptEdits",
      allowedTools: ["Bash"],
      includePartialMessages: true
    }
  })

  const deadline = setTimeout(() => {
    console.error("probe: timed out")
    live.finish()
  }, TIMEOUT_MS)

  // The adapter's `STEER_CONTINUE_GRACE`, mirrored so the probe ends the way a
  // real steered turn does rather than sitting on the deadline.
  const QUIET_MS = 2_500
  let quiet: ReturnType<typeof setTimeout> | undefined
  let results = 0
  let steered = false
  let sawSteerWord = false
  let assistantAfterSteer = ""

  try {
    for await (const msg of iterator as AsyncIterable<Record<string, unknown>>) {
      if (quiet !== undefined) clearTimeout(quiet)
      const type = msg.type as string | undefined
      if (type === "assistant") {
        const content = (msg.message as { content?: unknown } | undefined)?.content
        const text = Array.isArray(content)
          ? content
              .filter((b) => (b as { type?: string }).type === "text")
              .map((b) => (b as { text?: string }).text ?? "")
              .join("")
          : ""
        if (steered) assistantAfterSteer += text
        if (text.includes(STEER_WORD)) sawSteerWord = true
      }
      // Push once, mid-turn, after the first tool result — the exact moment the
      // renderer's auto-flush fires (`ToolEnd`).
      //
      // `--at-result` instead pushes at the WORST possible moment: as the turn's
      // own `result` is being handled. That is the window a review flagged as a
      // silent-loss risk — the SDK may have already drained the message out of
      // `pending`, so `hasUnread()` reads false and the channel closes on input
      // the CLI never acted on.
      if (!steered && type === (atResult ? "result" : "user")) {
        steered = live.push(`Also reply with the word ${STEER_WORD}.`, [])
        console.log(`probe: pushed at ${atResult ? "the result" : "mid-turn"} (accepted=${steered})`)
      }
      if (type === "result") {
        results += 1
        // `--drain-first` is the review's premise made deterministic: give the SDK
        // a moment to pull the pushed message out of `pending` (so `hasUnread()`
        // reads false) BEFORE deciding, then close the channel on it. If the CLI
        // drops input it has received but not yet acted on, this loses the message.
        if (drainFirst) await new Promise((resolve) => setTimeout(resolve, 250))
        console.log(
          `probe: result #${results} (steered=${steered}, unread=${live.hasUnread()})`
        )
        // Exactly what the adapter does: any push during this turn makes the
        // result a seam rather than the end, so the channel stays open for a
        // continuation — closed by the same quiet window when none comes.
        if (live.takeSteered() || live.hasUnread()) {
          quiet = setTimeout(() => live.finish(), QUIET_MS)
        } else {
          live.finish()
        }
      }
    }
  } finally {
    clearTimeout(deadline)
    live.finish()
  }

  console.log(`probe: results=${results} steerWordSeen=${sawSteerWord}`)
  console.log(`probe: text after steer: ${assistantAfterSteer.slice(0, 200)}`)
  // Either shape is correct and the adapter handles both: answered inside the
  // running turn (one result), or in a continuation the CLI opens for it (two).
  // What must never happen is the message reaching the agent and going unanswered.
  if (sawSteerWord) {
    console.log(`probe: PASS — the push was answered (across ${results} result(s))`)
    return 0
  }
  console.error("probe: FAIL — the steered message never reached the agent")
  return 2
}

main().then(
  (code) => process.exit(code),
  (cause) => {
    console.error("probe: threw", cause)
    process.exit(2)
  }
)
