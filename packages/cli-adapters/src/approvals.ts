import { Deferred, Effect, Ref } from "effect"
import type {
  ApprovalGate,
  GateDecision,
  PermissionMode,
  QuestionAnswer
} from "@starbase/core"
import type { PermissionRequest, PlanDecision } from "./adapter.js"
import { PLAN_AUTO_RUN_DEFAULT } from "@starbase/core"

/**
 * Human-in-the-loop: what the agent must ask before doing, and what happens while
 * it waits.
 *
 * Split out of `AgentRunner` because it shares nothing with running a turn. It has
 * its own state (two registries of blocked agents and the per-chat allowlist), its
 * own vocabulary, and — most usefully — a decision at its centre that is pure. The
 * cost of leaving it inside was that `verdict`, the rule saying whether a command
 * needs approval, could only be exercised by starting a harness.
 *
 * The blocked agent is represented as a `Deferred` it is parked on. Answering,
 * denying and stopping are all the same act: complete the Deferred and let the
 * agent continue. Nothing here knows what a run is.
 */

/** A gate awaiting the operator; the `Deferred` unblocks the paused agent. */
interface PendingGate {
  readonly sessionId: string
  readonly chatId: string
  readonly deferred: Deferred.Deferred<PermissionDecision>
  /** Token added to the chat's allowlist on an "always" decision. */
  readonly allowLabel: string | null
}

/** A proposed plan awaiting the operator's decision; the `Deferred` resumes the agent. */
interface PendingPlan {
  readonly sessionId: string
  readonly chatId: string
  readonly deferred: Deferred.Deferred<PlanDecision>
}

/** A question group awaiting the user's answers; the `Deferred` resumes the agent. */
interface PendingQuestion {
  readonly sessionId: string
  readonly chatId: string
  readonly deferred: Deferred.Deferred<ReadonlyArray<QuestionAnswer>>
}

/** What `canUseTool` resolves to — the harness only understands these two. */
export type PermissionDecision = "allow" | "deny"

// ── The pure core ────────────────────────────────────────────────────────────

/** The first two words of a command — the "Always allow …" token, e.g. "npm test". */
export const allowLabelOf = (command: string): string =>
  command.trim().split(/\s+/).slice(0, 2).join(" ")

/**
 * Whether the allowlist covers `command`.
 *
 * Prefix-matched on a word boundary, so allowing "npm test" also allows
 * "npm test -- --watch" but never "npm test-and-deploy".
 */
export const isAllowlisted = (
  allow: ReadonlySet<string>,
  command: string | null
): boolean =>
  command !== null && [...allow].some((a) => command === a || command.startsWith(`${a} `))

const basename = (target: string | null): string => target?.split("/").pop() ?? "file"

/**
 * Decide whether a requested action runs (`"allow"`) or must pause for the
 * operator (`"gate"`), from the chat's HITL mode + allowlist:
 * - `auto` — everything runs,
 * - `accept-edits` — edits run, commands gate (unless allowlisted),
 * - `ask` — edits and commands both gate (unless a command is allowlisted).
 */
export const verdict = (
  mode: PermissionMode,
  allow: ReadonlySet<string>,
  req: PermissionRequest,
  planAutoRun: boolean = PLAN_AUTO_RUN_DEFAULT
): "allow" | "gate" => {
  if (mode === "auto") return "allow"
  if (isAllowlisted(allow, req.command)) return "allow"
  // Planning is a read-only phase: the harness refuses edits outright, so the
  // only thing left to approve is a command that cannot change the tree. Running
  // those unattended is the default; the operator can restore the prompts from
  // Settings. Edits are NOT covered — they fall through to the rule below and
  // gate exactly as they always did.
  if (mode === "plan" && planAutoRun && req.kind === "command") return "allow"
  if (req.kind === "edit") return mode === "accept-edits" ? "allow" : "gate"
  return "gate"
}

/** The operator-facing card for a gate. */
export const buildGate = (id: string, req: PermissionRequest): ApprovalGate =>
  req.kind === "command"
    ? {
        id,
        kind: "command",
        title: "Approval needed · run a command",
        detail:
          "Not in your allowlist. Agents never run shell commands until you allow — any file edits above were applied under this mode.",
        command: req.command,
        allowLabel: req.command ? allowLabelOf(req.command) : null,
        status: "pending"
      }
    : {
        id,
        kind: "edit",
        title: `Approval needed · edit ${basename(req.target)}`,
        detail: "Review the change above, then approve to write it to disk.",
        command: null,
        allowLabel: null,
        status: "pending"
      }

// ── The registry ─────────────────────────────────────────────────────────────

export interface Approvals {
  /**
   * Park the agent on a gate until the operator decides.
   *
   * `announce` is run by this module, AFTER the gate is registered and before the
   * wait begins. That ordering is the reason it is a parameter rather than the
   * caller's business: announcing first opens a window in which a decision can
   * arrive — the renderer answers the instant it sees the card — and find no gate
   * to release, leaving the agent parked forever.
   */
  readonly awaitGate: (
    sessionId: string,
    chatId: string,
    gateId: string,
    gate: ApprovalGate,
    announce: Effect.Effect<void>
  ) => Effect.Effect<PermissionDecision>
  /** Park the agent on a question group until answers arrive. Same ordering rule. */
  readonly awaitAnswers: (
    sessionId: string,
    chatId: string,
    requestId: string,
    announce: Effect.Effect<void>
  ) => Effect.Effect<ReadonlyArray<QuestionAnswer>>
  /**
   * Record the operator's gate decision. A no-op when the gate is unknown or
   * belongs to another chat — a stale click from a reloaded window must not
   * release somebody else's agent.
   *
   * Returns the allowlist token to persist on an "always", so the caller owns the
   * write to `SessionStore` and this module stays free of it.
   */
  readonly decide: (
    sessionId: string,
    chatId: string,
    gateId: string,
    decision: GateDecision
  ) => Effect.Effect<string | null>
  /** Submit answers to a pending question group. Same ownership guard as `decide`. */
  readonly answer: (
    sessionId: string,
    chatId: string,
    requestId: string,
    answers: ReadonlyArray<QuestionAnswer>
  ) => Effect.Effect<void>
  /** The chat's in-memory allowlist. */
  readonly allowlistFor: (chatId: string) => Effect.Effect<ReadonlySet<string>>
  /** Seed the chat's allowlist from persisted state. */
  readonly seedAllowlist: (
    chatId: string,
    labels: Iterable<string>
  ) => Effect.Effect<void>
  /**
   * Release everything a chat is parked on, because its run is stopping.
   * Gates deny and questions answer empty — a stopped agent must not stay blocked.
   */
  readonly releaseChat: (sessionId: string, chatId: string) => Effect.Effect<void>
  /**
   * Park the agent on a proposed plan until the operator decides. Same ordering
   * rule as `awaitGate` — `announce` also persists the plan to the library, which
   * must not happen before the plan can be answered.
   */
  readonly awaitPlan: (
    sessionId: string,
    chatId: string,
    planId: string,
    announce: Effect.Effect<void>
  ) => Effect.Effect<PlanDecision>
  /**
   * Who owns a pending plan, or null. The comment / revise / approve handlers all
   * begin with this lookup.
   */
  readonly pendingPlan: (
    planId: string
  ) => Effect.Effect<{ readonly sessionId: string; readonly chatId: string } | null>
  /**
   * Settle a pending plan. Guarded on the SESSION only — unlike gates, a plan is
   * addressed by an id unique across the session's chats, and the out-of-band plan
   * RPCs do not carry one.
   */
  readonly settlePlan: (
    sessionId: string,
    planId: string,
    decision: PlanDecision
  ) => Effect.Effect<void>
  /** Every plan a chat is parked on — the caller marks them rejected and settles them. */
  readonly pendingPlanIds: (
    sessionId: string,
    chatId: string
  ) => Effect.Effect<ReadonlyArray<string>>
  /** Drop a closed chat's allowlist so the map doesn't grow for the process's life. */
  readonly forgetChat: (chatId: string) => Effect.Effect<void>
}

/** Build an approvals registry. Independent of runs, sessions and harnesses. */
export const makeApprovals: Effect.Effect<Approvals> = Effect.gen(function* () {
  const gates = yield* Ref.make(new Map<string, PendingGate>())
  const questions = yield* Ref.make(new Map<string, PendingQuestion>())
  const allowlists = yield* Ref.make(new Map<string, Set<string>>())
  const plans = yield* Ref.make(new Map<string, PendingPlan>())

  const forget = <V>(ref: Ref.Ref<Map<string, V>>, key: string) =>
    Ref.update(ref, (m) => {
      if (!m.has(key)) return m
      const next = new Map(m)
      next.delete(key)
      return next
    })

  return {
    awaitGate: (sessionId, chatId, gateId, gate, announce) =>
      Effect.gen(function* () {
        const deferred = yield* Deferred.make<PermissionDecision>()
        yield* Ref.update(gates, (m) =>
          new Map(m).set(gateId, { sessionId, chatId, deferred, allowLabel: gate.allowLabel })
        )
        yield* announce
        const decision = yield* Deferred.await(deferred)
        yield* forget(gates, gateId)
        return decision
      }),

    awaitAnswers: (sessionId, chatId, requestId, announce) =>
      Effect.gen(function* () {
        const deferred = yield* Deferred.make<ReadonlyArray<QuestionAnswer>>()
        yield* Ref.update(questions, (m) =>
          new Map(m).set(requestId, { sessionId, chatId, deferred })
        )
        yield* announce
        const answers = yield* Deferred.await(deferred)
        yield* forget(questions, requestId)
        return answers
      }),

    decide: (sessionId, chatId, gateId, decision) =>
      Effect.gen(function* () {
        const entry = (yield* Ref.get(gates)).get(gateId)
        if (entry === undefined || entry.sessionId !== sessionId || entry.chatId !== chatId) {
          return null
        }
        const label = decision === "always" ? entry.allowLabel : null
        if (label !== null) {
          yield* Ref.update(allowlists, (m) => {
            const next = new Map(m)
            next.set(chatId, new Set(next.get(chatId) ?? []).add(label))
            return next
          })
        }
        yield* Deferred.succeed(entry.deferred, decision === "deny" ? "deny" : "allow")
        return label
      }),

    answer: (sessionId, chatId, requestId, answers) =>
      Effect.gen(function* () {
        const entry = (yield* Ref.get(questions)).get(requestId)
        if (entry === undefined || entry.sessionId !== sessionId || entry.chatId !== chatId) {
          return
        }
        // The answers are recorded onto the transcript by the caller, which owns
        // the run's message accumulator; here we only resume the agent.
        yield* Deferred.succeed(entry.deferred, answers)
      }),

    allowlistFor: (chatId) =>
      Effect.map(Ref.get(allowlists), (m) => m.get(chatId) ?? new Set<string>()),

    seedAllowlist: (chatId, labels) =>
      Ref.update(allowlists, (m) => new Map(m).set(chatId, new Set(labels))),

    releaseChat: (sessionId, chatId) =>
      Effect.gen(function* () {
        const owned = <V extends { sessionId: string; chatId: string }>(m: Map<string, V>) =>
          [...m.values()].filter((v) => v.sessionId === sessionId && v.chatId === chatId)
        yield* Effect.forEach(
          owned(yield* Ref.get(gates)),
          (g) => Deferred.succeed(g.deferred, "deny" as const),
          { discard: true }
        )
        yield* Effect.forEach(
          owned(yield* Ref.get(questions)),
          (q) => Deferred.succeed(q.deferred, [] as ReadonlyArray<QuestionAnswer>),
          { discard: true }
        )
      }),

    awaitPlan: (sessionId, chatId, planId, announce) =>
      Effect.gen(function* () {
        const deferred = yield* Deferred.make<PlanDecision>()
        yield* Ref.update(plans, (m) => new Map(m).set(planId, { sessionId, chatId, deferred }))
        yield* announce
        const decision = yield* Deferred.await(deferred)
        yield* forget(plans, planId)
        return decision
      }),

    pendingPlan: (planId) =>
      Effect.map(Ref.get(plans), (m) => {
        const entry = m.get(planId)
        return entry === undefined
          ? null
          : { sessionId: entry.sessionId, chatId: entry.chatId }
      }),

    settlePlan: (sessionId, planId, decision) =>
      Effect.gen(function* () {
        const entry = (yield* Ref.get(plans)).get(planId)
        if (entry === undefined || entry.sessionId !== sessionId) return
        yield* Deferred.succeed(entry.deferred, decision)
      }),

    pendingPlanIds: (sessionId, chatId) =>
      Effect.map(Ref.get(plans), (m) =>
        [...m.entries()]
          .filter(([, p]) => p.sessionId === sessionId && p.chatId === chatId)
          .map(([planId]) => planId)
      ),

    forgetChat: (chatId) => forget(allowlists, chatId)
  }
})
