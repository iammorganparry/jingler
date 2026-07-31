import { Schema } from "effect"
import { CliKind } from "./cli.js"
import { StreamEvent } from "./conversation.js"

/**
 * Provider-neutral worker lifecycle shared by orchestration, RPC, and renderer
 * projections. These values deliberately match the orchestration worker
 * machine; stage-only states such as `skipped` do not belong here.
 */
export const WorkerLifecycleStatus = Schema.Literal(
  "queued",
  "running",
  "blocked",
  "failed",
  "interrupted",
  "completed"
)
export type WorkerLifecycleStatus = Schema.Schema.Type<typeof WorkerLifecycleStatus>

const IdentityString = Schema.String.pipe(Schema.minLength(1))

/**
 * Stable identity and route for one logical plan worker attempt.
 *
 * `agentId` survives retries while `attempt` distinguishes their event streams.
 * Carrying the plan and producing chat makes each activity self-routing even
 * when several plans or chats are observed in the same renderer process.
 */
export const WorkerIdentity = Schema.Struct({
  sessionId: IdentityString,
  planId: IdentityString,
  producingChatId: IdentityString,
  agentId: IdentityString,
  stageIds: Schema.Array(IdentityString),
  harness: CliKind,
  model: IdentityString,
  attempt: Schema.Int.pipe(Schema.nonNegative())
})
export type WorkerIdentity = Schema.Schema.Type<typeof WorkerIdentity>

const WorkerStateFields = {
  worker: WorkerIdentity,
  status: WorkerLifecycleStatus,
  message: Schema.NullOr(Schema.String)
}

/** The latest lifecycle projection for one worker. */
export const WorkerState = Schema.Struct(WorkerStateFields)
export type WorkerState = Schema.Schema.Type<typeof WorkerState>

/**
 * Reset the listed workers' lifecycle projections and transcripts.
 *
 * `replace` is a complete snapshot and removes workers that are not listed.
 * `patch` resets only the listed workers, so a targeted retry leaves settled
 * siblings untouched. The plan scope is carried independently of `workers` so
 * even an empty reset is unambiguous.
 */
export const WorkerActivityReset = Schema.TaggedStruct("Reset", {
  sessionId: IdentityString,
  planId: IdentityString,
  producingChatId: IdentityString,
  mode: Schema.Literal("replace", "patch"),
  workers: Schema.Array(WorkerState)
})
export type WorkerActivityReset = Schema.Schema.Type<typeof WorkerActivityReset>

/** Replace one worker's lifecycle projection. */
export const WorkerActivityState = Schema.TaggedStruct("State", WorkerStateFields)
export type WorkerActivityState = Schema.Schema.Type<typeof WorkerActivityState>

/**
 * One normalized harness event emitted while a worker executes an assigned
 * stage. `stageId` disambiguates workers that own more than one stage.
 */
export const WorkerActivityHarnessEvent = Schema.TaggedStruct("HarnessEvent", {
  worker: WorkerIdentity,
  stageId: IdentityString,
  event: StreamEvent
})
export type WorkerActivityHarnessEvent = Schema.Schema.Type<
  typeof WorkerActivityHarnessEvent
>

/**
 * Read-only activity vocabulary for observing orchestration without coupling
 * the renderer to a concrete harness or causing execution as a side effect.
 */
export const WorkerActivity = Schema.Union(
  WorkerActivityReset,
  WorkerActivityState,
  WorkerActivityHarnessEvent
)
export type WorkerActivity = Schema.Schema.Type<typeof WorkerActivity>

// ── Plan-thread participants and mention delivery ───────────────────────────

/** The provider-neutral roles a plan comment can address. */
export const PlanParticipantRole = Schema.Literal(
  "orchestrator",
  "worker",
  "subagent"
)
export type PlanParticipantRole = Schema.Schema.Type<typeof PlanParticipantRole>

/**
 * Mention targets are deliberately limited to states that can still receive a
 * routed message. Terminal worker/sub-agent states stay in their activity
 * history but never appear in this projection.
 */
export const PlanParticipantLifecycle = Schema.Literal("parked", "running")
export type PlanParticipantLifecycle = Schema.Schema.Type<
  typeof PlanParticipantLifecycle
>

/**
 * One currently addressable plan-conversation participant.
 *
 * `routingId` includes the concrete run/attempt identity. Callers must send it
 * back unchanged; services compare it exactly and never redirect a stale id to
 * a newer attempt. Nested harness agents point at the route that can relay to
 * them because most provider SDKs do not expose an independent control handle.
 */
export const PlanParticipant = Schema.Struct({
  routingId: IdentityString,
  displayName: IdentityString,
  role: PlanParticipantRole,
  lifecycle: PlanParticipantLifecycle,
  ownerRoutingId: Schema.NullOr(IdentityString)
})
export type PlanParticipant = Schema.Schema.Type<typeof PlanParticipant>

export const PlanMentionDeliveryStatus = Schema.Literal(
  "delivered",
  "unavailable",
  "failed"
)
export type PlanMentionDeliveryStatus = Schema.Schema.Type<
  typeof PlanMentionDeliveryStatus
>

/** Per-target outcome returned after the durable message has been written. */
export const PlanMentionDelivery = Schema.Struct({
  participantId: IdentityString,
  status: PlanMentionDeliveryStatus,
  detail: Schema.NullOr(Schema.String),
  retryable: Schema.Boolean
})
export type PlanMentionDelivery = Schema.Schema.Type<typeof PlanMentionDelivery>

export const orchestratorParticipantRoutingId = (chatId: string): string =>
  `orchestrator:${chatId}`

export const workerParticipantRoutingId = (
  planId: string,
  agentId: string,
  attempt: number
): string => `worker:${planId}:${agentId}:${attempt}`

export const subagentParticipantRoutingId = (
  ownerRoutingId: string,
  agentId: string
): string => `subagent:${ownerRoutingId}:${agentId}`

/**
 * Merge participant sources without leaking settled targets or duplicate ids.
 * First writer wins so the owning service's display metadata remains stable.
 */
export const activePlanParticipants = (
  sources: ReadonlyArray<ReadonlyArray<PlanParticipant>>
): ReadonlyArray<PlanParticipant> => {
  const byId = new Map<string, PlanParticipant>()
  for (const source of sources) {
    for (const participant of source) {
      if (
        participant.lifecycle !== "parked" &&
        participant.lifecycle !== "running"
      ) continue
      if (!byId.has(participant.routingId)) {
        byId.set(participant.routingId, participant)
      }
    }
  }
  return [...byId.values()]
}

export interface ParsedPlanThreadReply {
  readonly body: string
  readonly mentionedParticipantIds: ReadonlyArray<string>
}

/**
 * Agents relay mentions with an intentionally tiny text protocol. Markers are
 * removed from the visible reply, de-duplicated, and dispatched by the caller
 * inside the same plan-thread operation.
 */
export const parsePlanThreadReply = (text: string): ParsedPlanThreadReply => {
  const mentionedParticipantIds: Array<string> = []
  const body = text
    .replace(/\[\[mention:([^\]\r\n]+)\]\]/g, (_match, participantId: string) => {
      const trimmed = participantId.trim()
      if (trimmed.length > 0 && !mentionedParticipantIds.includes(trimmed)) {
        mentionedParticipantIds.push(trimmed)
      }
      return ""
    })
    .replace(/[ \t]+\n/g, "\n")
    .trim()
  return { body, mentionedParticipantIds }
}

export const planThreadRelayPrompt = (input: {
  readonly annotationId: string
  readonly target: PlanParticipant
  readonly body: string
  readonly availableParticipants: ReadonlyArray<PlanParticipant>
}): string => {
  const available = input.availableParticipants
    .map(
      (participant) =>
        `- ${participant.displayName}: ${participant.routingId} (${participant.role})`
    )
    .join("\n")
  const relay =
    input.target.role === "subagent"
      ? `Relay this message to the active nested agent "${input.target.displayName}" (${input.target.routingId}) and return that agent's response.`
      : "Respond to the plan comment directly."
  return `[[plan-thread-message]]
Thread: ${input.annotationId}
Target: ${input.target.routingId}
${relay}

${input.body}

Keep the response scoped to this thread. To continue the conversation with
another active participant, include [[mention:ROUTING_ID]] in the response.
Currently active participants:
${available || "- none"}`
}
