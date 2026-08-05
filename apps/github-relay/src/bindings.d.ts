interface Env {
  /** Set with `wrangler secret put GITHUB_WEBHOOK_SECRET`. */
  GITHUB_WEBHOOK_SECRET: string
  /** Must match the server's GITHUB_APP_RELAY_SIGNING_SECRET. */
  GITHUB_RELAY_SIGNING_SECRET: string
}
