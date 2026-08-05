interface Env {
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
  /** Set with `wrangler secret put GITHUB_WEBHOOK_SECRET`. */
  GITHUB_WEBHOOK_SECRET: string
  /** Must match the server's GITHUB_APP_RELAY_SIGNING_SECRET. */
  GITHUB_RELAY_SIGNING_SECRET: string
}
