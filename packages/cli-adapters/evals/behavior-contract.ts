import type { AuthRouteKind, RuntimeContractVersions } from "@jingler/core"

export type FileChangeStatus = "A" | "M" | "D" | "R"

export type EvalObservation =
  | { readonly kind: "event"; readonly tag: string }
  | { readonly kind: "tool-call"; readonly tool: string; readonly risk: string }
  | { readonly kind: "tool-effect"; readonly tool: string }
  | { readonly kind: "permission"; readonly tool: string; readonly decision: "allow" | "deny" }
  | { readonly kind: "file-change"; readonly status: FileChangeStatus; readonly path: string; readonly oldPath: string | null }
  | { readonly kind: "auth-route"; readonly route: AuthRouteKind }
  | { readonly kind: "auth-fallback"; readonly from: AuthRouteKind; readonly to: AuthRouteKind }
  | { readonly kind: "resource"; readonly name: string; readonly state: "opened" | "closed" }
  | { readonly kind: "report-text"; readonly text: string }

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
  readonly requiredVersions: RuntimeContractVersions
}

export interface EvalTrace {
  readonly scenarioId: string
  readonly observations: ReadonlyArray<EvalObservation>
  readonly durationMs: number
  readonly tokens: number
  readonly costUsd: number
  readonly versions: RuntimeContractVersions
}

export const event = (tag: string): EvalMatcher => ({
  description: `event:${tag}`,
  matches: (observation) => observation.kind === "event" && observation.tag === tag
})

export const toolEffect = (tool: string): EvalMatcher => ({
  description: `tool-effect:${tool}`,
  matches: (observation) => observation.kind === "tool-effect" && observation.tool === tool
})

export const permission = (tool: string, decision: "allow" | "deny"): EvalMatcher => ({
  description: `permission:${tool}:${decision}`,
  matches: (observation) =>
    observation.kind === "permission" &&
    observation.tool === tool &&
    observation.decision === decision
})

export const fileChange = (status: FileChangeStatus, path: string): EvalMatcher => ({
  description: `file-change:${status}:${path}`,
  matches: (observation) =>
    observation.kind === "file-change" && observation.status === status && observation.path === path
})

export const authRoute = (route: AuthRouteKind): EvalMatcher => ({
  description: `auth-route:${route}`,
  matches: (observation) => observation.kind === "auth-route" && observation.route === route
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

export const before = (first: EvalMatcher, second: EvalMatcher): EvalOrdering => ({
  before: first,
  after: second
})
