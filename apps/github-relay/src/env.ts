/** Non-binding runtime policy. Secrets are supplied with `wrangler secret put`. */
export const RELAY_POLICY = {
  maxWebhookBytes: 2 * 1024 * 1024,
  maxReplayEvents: 500,
  maxStoredEvents: 5_000,
  eventRetentionMs: 7 * 24 * 60 * 60 * 1_000
} as const

/** Structured operational telemetry. Callers pass identities/counts, never payload bodies. */
export const relayTelemetry = (
  event: string,
  fields: Readonly<Record<string, string | number | boolean | null>> = {}
): void => {
  console.log({
    level: "info",
    service: "@jingler/github-relay",
    event,
    ...fields
  })
}
