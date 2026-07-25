import { Effect, Fiber } from "effect"
import { describe, expect, it } from "vitest"
import type { QuestionAnswer } from "@starbase/core"
import { allowLabelOf, buildGate, isAllowlisted, makeApprovals, verdict } from "./approvals.js"
import type { PermissionRequest } from "./adapter.js"

/**
 * Approvals, tested without a harness.
 *
 * All of this used to be reachable only by starting a run: the rule saying whether
 * a command needs the operator, and the registry that parks the agent while it
 * waits. Both are self-contained, so both are checked here in milliseconds rather
 * than through a scripted turn.
 */

const cmd = (command: string): PermissionRequest => ({
  kind: "command",
  tool: "Bash",
  command,
  target: null
})
const edit: PermissionRequest = { kind: "edit", tool: "Edit", command: null, target: "src/a.ts" }
const none = new Set<string>()

/** A real gate card, built the way the runner builds it. */
const gateFor = (command: string) => buildGate("g1", cmd(command))

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

describe("verdict", () => {
  it("runs everything in auto", () => {
    expect(verdict("auto", none, cmd("rm -rf /"))).toBe("allow")
    expect(verdict("auto", none, edit)).toBe("allow")
  })

  it("gates commands but not edits in accept-edits", () => {
    expect(verdict("accept-edits", none, edit)).toBe("allow")
    expect(verdict("accept-edits", none, cmd("npm test"))).toBe("gate")
  })

  it("gates both in ask", () => {
    expect(verdict("ask", none, edit)).toBe("gate")
    expect(verdict("ask", none, cmd("npm test"))).toBe("gate")
  })

  it("lets an allowlisted command through in any gating mode", () => {
    const allow = new Set(["npm test"])
    expect(verdict("ask", allow, cmd("npm test"))).toBe("allow")
    expect(verdict("accept-edits", allow, cmd("npm test -- --watch"))).toBe("allow")
  })

  it("runs read-only commands in plan mode, but still gates edits", () => {
    // Planning cannot change the tree — the harness refuses edits outright — so the
    // only thing left to approve is a command that cannot do harm.
    expect(verdict("plan", none, cmd("ls"), true)).toBe("allow")
    expect(verdict("plan", none, edit, true)).toBe("gate")
    // …unless the operator turned auto-run off.
    expect(verdict("plan", none, cmd("ls"), false)).toBe("gate")
  })
})

describe("isAllowlisted", () => {
  it("matches on a word boundary, never a bare prefix", () => {
    const allow = new Set(["npm test"])
    expect(isAllowlisted(allow, "npm test")).toBe(true)
    expect(isAllowlisted(allow, "npm test -- --watch")).toBe(true)
    // The bug this shape prevents: allowing "npm test" must not also allow a
    // different command that merely starts with the same characters.
    expect(isAllowlisted(allow, "npm test-and-deploy")).toBe(false)
    expect(isAllowlisted(allow, null)).toBe(false)
  })
})

describe("allowLabelOf", () => {
  it("takes the first two words, so the token is the command not its arguments", () => {
    expect(allowLabelOf("  npm test -- --watch ")).toBe("npm test")
    expect(allowLabelOf("ls")).toBe("ls")
  })
})

describe("the approvals registry", () => {
  it("releases the parked agent with the operator's decision", async () => {
    const decision = await run(
      Effect.gen(function* () {
        const approvals = yield* makeApprovals
        // Deciding from `announce` is how the test gets determinism: the module
        // guarantees the gate is registered before it runs.
        return yield* approvals.awaitGate(
          "s1",
          "c1",
          "g1",
          gateFor("npm test"),
          Effect.asVoid(approvals.decide("s1", "c1", "g1", "allow"))
        )
      }).pipe(Effect.timeout("2 seconds"))
    )
    expect(decision).toBe("allow")
  })

  it("announces only AFTER the gate is registered", async () => {
    // The ordering `awaitGate` exists to guarantee. Announcing first would open a
    // window in which the renderer's decision — sent the instant it sees the card —
    // finds an empty registry and leaves the agent parked forever.
    const decision = await run(
      Effect.gen(function* () {
        const approvals = yield* makeApprovals
        return yield* approvals.awaitGate(
          "s1",
          "c1",
          "g1",
          gateFor("npm test"),
          Effect.asVoid(approvals.decide("s1", "c1", "g1", "deny"))
        )
      }).pipe(Effect.timeout("2 seconds"))
    )
    expect(decision).toBe("deny")
  })

  it("adds the allowlist token on an 'always', and reports it for persisting", async () => {
    const result = await run(
      Effect.gen(function* () {
        const approvals = yield* makeApprovals
        let label: string | null = null
        yield* approvals.awaitGate(
          "s1",
          "c1",
          "g1",
          gateFor("npm test"),
          Effect.gen(function* () {
            label = yield* approvals.decide("s1", "c1", "g1", "always")
          })
        )
        return { label, allow: [...(yield* approvals.allowlistFor("c1"))] }
      }).pipe(Effect.timeout("2 seconds"))
    )
    // Returned rather than written: the registry deliberately owns no store, so the
    // durable write stays with the rest of the session state.
    expect(result.label).toBe("npm test")
    expect(result.allow).toEqual(["npm test"])
  })

  it("ignores a decision aimed at another chat, leaving the agent parked", async () => {
    const stillParked = await run(
      Effect.gen(function* () {
        const approvals = yield* makeApprovals
        const parked = yield* Effect.fork(
          approvals.awaitGate(
            "s1",
            "c1",
            "g1",
            gateFor("npm test"),
            // A stale click from a reloaded window, and one from another session.
            Effect.gen(function* () {
              yield* approvals.decide("s1", "OTHER", "g1", "allow")
              yield* approvals.decide("OTHER", "c1", "g1", "allow")
            })
          )
        )
        const released = yield* Fiber.join(parked).pipe(
          Effect.timeout("200 millis"),
          Effect.as(true),
          Effect.orElseSucceed(() => false)
        )
        yield* Fiber.interrupt(parked)
        return !released
      })
    )
    expect(stillParked).toBe(true)
  })

  it("denies every gate the chat is parked on when its run stops", async () => {
    const decision = await run(
      Effect.gen(function* () {
        const approvals = yield* makeApprovals
        return yield* approvals.awaitGate(
          "s1",
          "c1",
          "g1",
          gateFor("npm test"),
          approvals.releaseChat("s1", "c1")
        )
      }).pipe(Effect.timeout("2 seconds"))
    )
    // A stopped agent must not stay blocked.
    expect(decision).toBe("deny")
  })

  it("answers a parked question group", async () => {
    const given: ReadonlyArray<QuestionAnswer> = [{ selected: ["yes"], other: null }]
    const answers = await run(
      Effect.gen(function* () {
        const approvals = yield* makeApprovals
        return yield* approvals.awaitAnswers(
          "s1",
          "c1",
          "q1",
          Effect.asVoid(approvals.answer("s1", "c1", "q1", given))
        )
      }).pipe(Effect.timeout("2 seconds"))
    )
    expect(answers).toEqual(given)
  })

  it("empties a parked question group when its run stops", async () => {
    const answers = await run(
      Effect.gen(function* () {
        const approvals = yield* makeApprovals
        return yield* approvals.awaitAnswers(
          "s1",
          "c1",
          "q1",
          approvals.releaseChat("s1", "c1")
        )
      }).pipe(Effect.timeout("2 seconds"))
    )
    expect(answers).toEqual([])
  })

  it("keeps allowlists per chat, and forgets a closed one", async () => {
    const result = await run(
      Effect.gen(function* () {
        const approvals = yield* makeApprovals
        yield* approvals.seedAllowlist("c1", ["npm test"])
        yield* approvals.seedAllowlist("c2", ["git status"])
        const before = [...(yield* approvals.allowlistFor("c1"))]
        const other = [...(yield* approvals.allowlistFor("c2"))]
        yield* approvals.forgetChat("c1")
        return { before, other, after: [...(yield* approvals.allowlistFor("c1"))] }
      })
    )
    expect(result.before).toEqual(["npm test"])
    expect(result.other).toEqual(["git status"])
    // Closing a chat must not leave its allowlist behind for the process's life.
    expect(result.after).toEqual([])
  })
})
