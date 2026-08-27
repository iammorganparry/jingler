import {
  AuthRouteKind,
  RuntimeContractVersions,
  type RuntimeContractVersions as RuntimeContractVersionsType
} from "@jingler/core"
import { Schema } from "effect"

export const EvalFileChangeStatus = Schema.Literal("A", "M", "D", "R")
export type EvalFileChangeStatus = Schema.Schema.Type<typeof EvalFileChangeStatus>

export const EvalObservation = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("event"), tag: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("tool-call"), tool: Schema.String, risk: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("tool-effect"), tool: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("permission"),
    tool: Schema.String,
    decision: Schema.Literal("allow", "deny")
  }),
  Schema.Struct({
    kind: Schema.Literal("file-change"),
    status: EvalFileChangeStatus,
    path: Schema.String,
    oldPath: Schema.NullOr(Schema.String)
  }),
  Schema.Struct({ kind: Schema.Literal("auth-route"), route: AuthRouteKind }),
  Schema.Struct({
    kind: Schema.Literal("auth-fallback"),
    from: AuthRouteKind,
    to: AuthRouteKind
  }),
  Schema.Struct({
    kind: Schema.Literal("resource"),
    name: Schema.String,
    state: Schema.Literal("opened", "closed")
  }),
  Schema.Struct({ kind: Schema.Literal("report-text"), text: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("tool-output"), tool: Schema.String, text: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("file-content"), path: Schema.String, text: Schema.String })
)
export type EvalObservation = Schema.Schema.Type<typeof EvalObservation>

export interface EvalMatcher {
  readonly description: string
  readonly matches: (observation: EvalObservation) => boolean
}

export interface EvalOrdering {
  readonly before: EvalMatcher
  readonly after: EvalMatcher
}

export interface EvalScenario {
  readonly id: string
  readonly capability: string
  readonly required: ReadonlyArray<EvalMatcher>
  readonly forbidden: ReadonlyArray<EvalMatcher>
  readonly ordering: ReadonlyArray<EvalOrdering>
  readonly timeoutMs: number
  readonly requiredVersions: RuntimeContractVersionsType
}

export const EvalTrace = Schema.Struct({
  scenarioId: Schema.String,
  observations: Schema.Array(EvalObservation),
  durationMs: Schema.Number,
  tokens: Schema.Number,
  costUsd: Schema.Number,
  versions: RuntimeContractVersions
})
export type EvalTrace = Schema.Schema.Type<typeof EvalTrace>

export const event = (tag: string): EvalMatcher => ({
  description: `event:${tag}`,
  matches: (observation) => observation.kind === "event" && observation.tag === tag
})

export const toolEffect = (tool: string): EvalMatcher => ({
  description: `tool-effect:${tool}`,
  matches: (observation) => observation.kind === "tool-effect" && observation.tool === tool
})

export const toolCall = (tool: string): EvalMatcher => ({
  description: `tool-call:${tool}`,
  matches: (observation) => observation.kind === "tool-call" && observation.tool === tool
})

export const permission = (tool: string, decision: "allow" | "deny"): EvalMatcher => ({
  description: `permission:${tool}:${decision}`,
  matches: (observation) =>
    observation.kind === "permission" &&
    observation.tool === tool &&
    observation.decision === decision
})

export const fileChange = (status: EvalFileChangeStatus, path: string): EvalMatcher => ({
  description: `file-change:${status}:${path}`,
  matches: (observation) =>
    observation.kind === "file-change" && observation.status === status && observation.path === path
})

export const authRoute = (route: AuthRouteKind): EvalMatcher => ({
  description: `auth-route:${route}`,
  matches: (observation) => observation.kind === "auth-route" && observation.route === route
})

export const authRouteObserved = (): EvalMatcher => ({
  description: "auth-route",
  matches: (observation) => observation.kind === "auth-route"
})

export const authFallback = (): EvalMatcher => ({
  description: "auth-fallback",
  matches: (observation) => observation.kind === "auth-fallback"
})

export const resourceOpened = (name: string): EvalMatcher => ({
  description: `resource-opened:${name}`,
  matches: (observation) => observation.kind === "resource" && observation.name === name && observation.state === "opened"
})

export const resourceClosed = (name: string): EvalMatcher => ({
  description: `resource-closed:${name}`,
  matches: (observation) => observation.kind === "resource" && observation.name === name && observation.state === "closed"
})

export const reportContains = (value: string): EvalMatcher => ({
  description: `report-contains:${value}`,
  matches: (observation) => observation.kind === "report-text" && observation.text.includes(value)
})

export const reportEquals = (value: string): EvalMatcher => ({
  description: `report-equals:${value}`,
  matches: (observation) => observation.kind === "report-text" && observation.text === value
})

export const toolOutputContains = (tool: string, value: string): EvalMatcher => ({
  description: `tool-output-contains:${tool}:${value}`,
  matches: (observation) =>
    observation.kind === "tool-output" && observation.tool === tool && observation.text.includes(value)
})

export const fileContentContains = (path: string, value: string): EvalMatcher => ({
  description: `file-content-contains:${path}:${value}`,
  matches: (observation) =>
    observation.kind === "file-content" && observation.path === path && observation.text.includes(value)
})

export const before = (first: EvalMatcher, second: EvalMatcher): EvalOrdering => ({
  before: first,
  after: second
})
