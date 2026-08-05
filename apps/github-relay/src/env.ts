/** Non-binding runtime policy. Secrets are supplied with `wrangler secret put`. */
export const RELAY_POLICY = {
  maxWebhookBytes: 2 * 1024 * 1024,
  maxReplayEvents: 500,
  maxStoredEvents: 5_000,
  maxSubscriptionsPerInstallation: 10_000,
  eventRetentionMs: 7 * 24 * 60 * 60 * 1_000,
  subscriptionRetentionMs: 10 * 60 * 1_000
} as const
