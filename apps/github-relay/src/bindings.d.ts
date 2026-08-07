interface GitHubRelaySecrets {
  /** Set with `wrangler secret put GITHUB_WEBHOOK_SECRET`. */
  GITHUB_WEBHOOK_SECRET: string
  /** Must match the server's GITHUB_APP_RELAY_SIGNING_SECRET. */
  GITHUB_RELAY_SIGNING_SECRET: string
  /**
   * This GitHub App's numeric id (same value as the server's GITHUB_APP_ID).
   * Lets the relay recognise — and drop — feedback the app itself posted, so a
   * review Jingler submits never routes back into its own session. Public, not a
   * secret: set as a `var` in wrangler.jsonc or via `wrangler secret put`.
   */
  GITHUB_APP_ID: string
}

interface Env extends GitHubRelaySecrets {
  SESSION_EVENTS: DurableObjectNamespace<
    import("./session-events.js").SessionEventsObject
  >
  INSTALLATION_ROUTES: DurableObjectNamespace<
    import("./installation-routes.js").InstallationRoutesObject
  >
  GITHUB_DELIVERY_WORKFLOW: Workflow<
    import("./github-webhook.js").NormalizedGitHubEvent
  >
  RELAY_REGISTRATION_WORKFLOW: Workflow<
    import("./workflows/relay-registration.js").RelayRegistrationParams
  >
}

declare namespace Cloudflare {
  interface Env extends GitHubRelaySecrets {}
}
