import type { EvalResult, RuntimeContractVersions } from "@jingler/core"
import type { EvalMatcher, EvalScenario, EvalTrace } from "./behavior-contract.js"

const versionFailures = (
  expected: RuntimeContractVersions,
  actual: RuntimeContractVersions
): ReadonlyArray<string> =>
  Object.entries(expected).flatMap(([name, value]) =>
    actual[name as keyof RuntimeContractVersions] === value
      ? []
      : [`version mismatch for ${name}`]
  )

const firstIndex = (trace: EvalTrace, matcher: EvalMatcher): number =>
  trace.observations.findIndex(matcher.matches)

const matcherFailures = (scenario: EvalScenario, trace: EvalTrace): ReadonlyArray<string> => [
  ...scenario.required.flatMap((matcher) =>
    trace.observations.some(matcher.matches) ? [] : [`missing ${matcher.description}`]
  ),
  ...scenario.forbidden.flatMap((matcher) =>
    trace.observations.some(matcher.matches) ? [`forbidden ${matcher.description}`] : []
  ),
  ...scenario.ordering.flatMap((ordering) => {
    const beforeIndex = firstIndex(trace, ordering.before)
    const afterIndex = firstIndex(trace, ordering.after)
    return beforeIndex === -1 || afterIndex === -1 || beforeIndex >= afterIndex
      ? [`ordering ${ordering.before.description} before ${ordering.after.description}`]
      : []
  })
]

export const scoreScenario = (
  scenario: EvalScenario,
  trace: EvalTrace
): EvalResult => {
  const failures: Array<string> = []
  if (trace.scenarioId !== scenario.id) failures.push("scenario id mismatch")
  failures.push(...versionFailures(scenario.requiredVersions, trace.versions))
  if (trace.durationMs > scenario.timeoutMs) failures.push("scenario timed out")

  failures.push(...matcherFailures(scenario, trace))

  const terminals = trace.observations.filter(
    (observation) =>
      observation.kind === "event" &&
      ["Done", "Failed", "Interrupted"].includes(observation.tag)
  )
  if (terminals.length !== 1) failures.push("expected exactly one terminal event")

  return {
    scenarioId: scenario.id,
    status: trace.durationMs > scenario.timeoutMs
      ? "timed-out"
      : failures.length === 0
        ? "passed"
        : "failed",
    failures,
    durationMs: trace.durationMs,
    tokens: trace.tokens,
    costUsd: trace.costUsd
  }
}

export const redactReport = (
  value: string,
  secrets: ReadonlyArray<string>
): string =>
  secrets
    .filter((secret) => secret.length > 0)
    .reduce((redacted, secret) => redacted.split(secret).join("[REDACTED]"), value)

/** Render only an error's public message; nested provider causes may contain credentials. */
export const redactErrorMessage = (
  error: Error,
  secrets: ReadonlyArray<string>
): string => redactReport(error.message, secrets)

export const assertReportRedacted = (
  value: string,
  secrets: ReadonlyArray<string>
): ReadonlyArray<string> =>
  secrets
    .filter((secret) => secret.length > 0 && value.includes(secret))
    .map(() => "report contains a configured secret")
