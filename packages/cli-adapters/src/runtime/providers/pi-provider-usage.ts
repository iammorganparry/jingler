import type { AuthKind, UsageStatus, UsageWindow } from "@jingler/core"
import { Option, Schema } from "effect"

/**
 * Live plan-usage windows read straight from the subscription providers'
 * usage endpoints — the replacement for the harness `/usage` control request
 * that died with the PI-runtime migration.
 *
 * Each response is decoded once against a schema of the captured real shape
 * (2026-08). The endpoints are not versioned contracts, so a response that no
 * longer decodes degrades to `null` ("usage isn't available"), never to a
 * crash or a wrong number.
 */

export interface LiveProviderUsage {
  readonly plan: string | null
  readonly windows: ReadonlyArray<UsageWindow>
}

/** A usage read either yields windows or says exactly why it could not. */
export type ProviderUsageRead =
  | { readonly available: true; readonly usage: LiveProviderUsage }
  | { readonly available: false; readonly reason: string }
  /** This auth route has no usage surface at all (API keys bill per token). */
  | null

const unavailable = (reason: string): ProviderUsageRead => ({
  available: false,
  reason
})

const statusFor = (utilization: number | null): UsageStatus =>
  utilization === null
    ? "unknown"
    : utilization >= 98
      ? "limited"
      : utilization >= 75
        ? "nearing"
        : "ok"

const clampPercent = (value: number): number => Math.min(100, Math.max(0, value))

const isoFromString = (value: string | null | undefined): string | null =>
  typeof value === "string" && !Number.isNaN(Date.parse(value))
    ? new Date(value).toISOString()
    : null

const isoFromUnixSeconds = (value: number | null | undefined): string | null =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? new Date(value * 1000).toISOString()
    : null

const titleCase = (value: string): string =>
  value.length === 0 ? value : `${value[0]!.toUpperCase()}${value.slice(1)}`

const getJson = async (
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal
): Promise<{ readonly status: number; readonly body: unknown }> => {
  const response = await fetch(url, { headers, signal })
  if (!response.ok) return { status: response.status, body: null }
  return { status: response.status, body: await response.json().catch(() => null) }
}

// ── Anthropic (Claude Pro/Max OAuth) ─────────────────────────────────────────
//
// GET https://api.anthropic.com/api/oauth/usage (captured):
//   { "five_hour": {"utilization": 14.0, "resets_at": "2026-08-14T13:59:59+00:00", …},
//     "seven_day": {…}, "seven_day_opus": null, …,
//     "limits": [{"kind": "session", "percent": 14, "resets_at": "…", …}, …] }

const ANTHROPIC_USAGE_URL = "https://api.anthropic.com/api/oauth/usage"

const AnthropicWindow = Schema.Struct({
  utilization: Schema.NullOr(Schema.Number),
  resets_at: Schema.NullOr(Schema.String)
})

const AnthropicLimit = Schema.Struct({
  kind: Schema.String,
  percent: Schema.NullOr(Schema.Number),
  resets_at: Schema.optionalWith(Schema.NullOr(Schema.String), {
    default: () => null
  })
})

const AnthropicUsageResponse = Schema.Struct({
  subscription_type: Schema.optionalWith(Schema.NullOr(Schema.String), {
    default: () => null
  }),
  five_hour: Schema.optionalWith(Schema.NullOr(AnthropicWindow), {
    default: () => null
  }),
  seven_day: Schema.optionalWith(Schema.NullOr(AnthropicWindow), {
    default: () => null
  }),
  seven_day_sonnet: Schema.optionalWith(Schema.NullOr(AnthropicWindow), {
    default: () => null
  }),
  seven_day_opus: Schema.optionalWith(Schema.NullOr(AnthropicWindow), {
    default: () => null
  }),
  limits: Schema.optionalWith(Schema.NullOr(Schema.Array(AnthropicLimit)), {
    default: () => null
  })
})
type AnthropicUsageResponse = Schema.Schema.Type<typeof AnthropicUsageResponse>

const decodeAnthropicUsage = Schema.decodeUnknownOption(AnthropicUsageResponse)

const ANTHROPIC_LIMIT_LABELS: Readonly<Record<string, string>> = {
  session: "Current session",
  weekly_all: "Weekly · all models",
  weekly_sonnet: "Weekly · Sonnet",
  weekly_opus: "Weekly · Opus"
}

/** The named `limits` entries: the endpoint's own summary of active windows. */
const anthropicLimitWindows = (
  usage: AnthropicUsageResponse
): ReadonlyArray<UsageWindow> =>
  (usage.limits ?? []).flatMap((limit): ReadonlyArray<UsageWindow> => {
    if (limit.percent === null) return []
    const utilization = clampPercent(limit.percent)
    return [{
      label: ANTHROPIC_LIMIT_LABELS[limit.kind] ?? limit.kind.replace(/_/gu, " "),
      resetsAt: isoFromString(limit.resets_at),
      utilization,
      status: statusFor(utilization)
    }]
  })

/** Fallback: the top-level window fields (`five_hour`, `seven_day`, …). */
const anthropicKeyedWindows = (
  usage: AnthropicUsageResponse
): ReadonlyArray<UsageWindow> => {
  const keyed: ReadonlyArray<readonly [string, AnthropicUsageResponse["five_hour"]]> = [
    ["Current session", usage.five_hour],
    ["Weekly · all models", usage.seven_day],
    ["Weekly · Sonnet", usage.seven_day_sonnet],
    ["Weekly · Opus", usage.seven_day_opus]
  ]
  return keyed.flatMap(([label, window]): ReadonlyArray<UsageWindow> => {
    if (window === null) return []
    const utilization = window.utilization === null ? null : clampPercent(window.utilization)
    const resetsAt = isoFromString(window.resets_at)
    if (utilization === null && resetsAt === null) return []
    return [{ label, resetsAt, utilization, status: statusFor(utilization) }]
  })
}

const fetchAnthropicOAuthUsage = async (
  access: string,
  signal: AbortSignal
): Promise<ProviderUsageRead> => {
  const { status, body } = await getJson(
    ANTHROPIC_USAGE_URL,
    {
      Authorization: `Bearer ${access}`,
      "anthropic-beta": "oauth-2025-04-20",
      "Content-Type": "application/json"
    },
    signal
  )
  if (body === null) {
    return unavailable(
      status === 401 || status === 403
        ? `Anthropic's usage endpoint rejected this credential (HTTP ${status}) — a pasted setup-token may not carry the usage scope.`
        : `Anthropic's usage endpoint answered HTTP ${status}.`
    )
  }
  const usage = Option.getOrNull(decodeAnthropicUsage(body))
  if (usage === null) {
    return unavailable("Anthropic's usage response no longer matches the known shape.")
  }
  const fromLimits = anthropicLimitWindows(usage)
  const windows = fromLimits.length > 0 ? fromLimits : anthropicKeyedWindows(usage)
  if (windows.length === 0) {
    return unavailable("Anthropic reported no usage windows for this account.")
  }
  return {
    available: true,
    usage: {
      plan: usage.subscription_type === null ? null : titleCase(usage.subscription_type),
      windows
    }
  }
}

// ── OpenAI Codex (ChatGPT subscription) ──────────────────────────────────────
//
// GET https://chatgpt.com/backend-api/wham/usage (captured):
//   { "plan_type": "pro",
//     "rate_limit": { "primary_window": {"used_percent": 32,
//         "limit_window_seconds": 604800, "reset_after_seconds": 490350,
//         "reset_at": 1787201929 }, "secondary_window": null } }

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"

const CodexWindow = Schema.Struct({
  used_percent: Schema.Number,
  limit_window_seconds: Schema.optionalWith(Schema.NullOr(Schema.Number), {
    default: () => null
  }),
  reset_after_seconds: Schema.optionalWith(Schema.NullOr(Schema.Number), {
    default: () => null
  }),
  reset_at: Schema.optionalWith(Schema.NullOr(Schema.Number), {
    default: () => null
  })
})
type CodexWindow = Schema.Schema.Type<typeof CodexWindow>

const CodexRateLimit = Schema.Struct({
  primary_window: Schema.NullOr(CodexWindow),
  secondary_window: Schema.NullOr(CodexWindow)
})

const CodexAdditionalLimit = Schema.Struct({
  limit_name: Schema.optionalWith(Schema.NullOr(Schema.String), {
    default: () => null
  }),
  rate_limit: Schema.NullOr(CodexRateLimit)
})

const CodexUsageResponse = Schema.Struct({
  plan_type: Schema.optionalWith(Schema.NullOr(Schema.String), {
    default: () => null
  }),
  rate_limit: Schema.NullOr(CodexRateLimit),
  /** Per-model metered limits (e.g. "GPT-5.3-Codex-Spark") beside the plan's. */
  additional_rate_limits: Schema.optionalWith(
    Schema.NullOr(Schema.Array(CodexAdditionalLimit)),
    { default: () => null }
  )
})

const decodeCodexUsage = Schema.decodeUnknownOption(CodexUsageResponse)

const codexWindowLabel = (windowSeconds: number | null): string => {
  if (windowSeconds === null) return "Plan limit"
  const hours = windowSeconds / 3600
  if (hours <= 24) return `Current session (${Math.round(hours)}h)`
  return `Weekly (${Math.round(hours / 24)}d)`
}

const codexWindow = (
  window: CodexWindow | null,
  labelPrefix: string | null = null
): UsageWindow | null => {
  if (window === null) return null
  const utilization = clampPercent(window.used_percent)
  const label = codexWindowLabel(window.limit_window_seconds)
  return {
    label: labelPrefix === null ? label : `${labelPrefix} · ${label}`,
    resetsAt:
      isoFromUnixSeconds(window.reset_at) ??
      (window.reset_after_seconds === null
        ? null
        : new Date(Date.now() + window.reset_after_seconds * 1000).toISOString()),
    utilization,
    status: statusFor(utilization)
  }
}

const fetchCodexUsage = async (
  access: string,
  accountId: string | null,
  signal: AbortSignal
): Promise<ProviderUsageRead> => {
  const { status, body } = await getJson(
    CODEX_USAGE_URL,
    {
      Authorization: `Bearer ${access}`,
      ...(accountId === null ? {} : { "chatgpt-account-id": accountId }),
      // The backend rejects unidentified clients; identify like the CLI does.
      "User-Agent": "codex_cli_rs",
      "Content-Type": "application/json"
    },
    signal
  )
  if (body === null) {
    return unavailable(`ChatGPT's usage endpoint answered HTTP ${status}.`)
  }
  const usage = Option.getOrNull(decodeCodexUsage(body))
  if (usage === null) {
    return unavailable("ChatGPT's usage response no longer matches the known shape.")
  }
  const planWindows =
    usage.rate_limit === null
      ? []
      : [usage.rate_limit.primary_window, usage.rate_limit.secondary_window].map(
          (window) => codexWindow(window)
        )
  const additionalWindows = (usage.additional_rate_limits ?? []).flatMap(
    (limit) =>
      limit.rate_limit === null
        ? []
        : [limit.rate_limit.primary_window, limit.rate_limit.secondary_window].map(
            (window) => codexWindow(window, limit.limit_name)
          )
  )
  const windows = [...planWindows, ...additionalWindows].filter(
    (window): window is UsageWindow => window !== null
  )
  if (windows.length === 0) {
    return unavailable("ChatGPT reported no usage windows for this account.")
  }
  return {
    available: true,
    usage: {
      plan: usage.plan_type === null ? null : titleCase(usage.plan_type),
      windows
    }
  }
}

/**
 * Live usage for one authenticated connection. `null` means this auth route
 * has no usage surface at all (API keys bill per token — there is no plan
 * window to show); an unavailable read carries the provider's actual refusal.
 */
export const fetchPiProviderUsage = async (input: {
  readonly authKind: AuthKind
  readonly access: string
  readonly accountId: string | null
  readonly signal: AbortSignal
}): Promise<ProviderUsageRead> => {
  if (input.authKind === "claude-setup-token") {
    return fetchAnthropicOAuthUsage(input.access, input.signal)
  }
  if (input.authKind === "openai-codex-oauth") {
    return fetchCodexUsage(input.access, input.accountId, input.signal)
  }
  return null
}
