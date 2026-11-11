// The full no-external bundle ships the session recorder inline: the CSP blocks
// every remote script, so the default lazy-loaded recorder could never load.
import posthog from "posthog-js/dist/module.full.no-external.js"

export type TelemetryState = "off" | "in" | "out"

/** No key (dev, forks, e2e builds) means telemetry never starts; otherwise absent config means on. */
export const telemetryState = (key: string | undefined, enabled: boolean | undefined): TelemetryState =>
  !key ? "off" : enabled === false ? "out" : "in"

let started = false

/** Start, pause or resume PostHog to match `config.telemetryEnabled`. Call only once config has loaded. */
export function applyTelemetry(
  enabled: boolean | undefined,
  key: string | undefined = import.meta.env.VITE_POSTHOG_KEY,
  e2e: boolean = typeof window !== "undefined" && window.jingler?.isE2E === true
): void {
  const state = e2e ? "off" : telemetryState(key, enabled)
  if (state === "off" || key === undefined) return
  if (state === "out") {
    if (started) posthog.opt_out_capturing()
    return
  }
  if (started) {
    posthog.opt_in_capturing()
    return
  }
  started = true
  posthog.init(key, {
    // Main forwards to the real host; see main/telemetry-proxy.ts for why the renderer can't reach it.
    api_host: "jingler-telemetry://posthog",
    defaults: "2025-05-24",
    disable_external_dependency_loading: true,
    // One window, no routes: pageviews would be noise.
    capture_pageview: false,
    capture_exceptions: true,
    person_profiles: "identified_only",
    disable_surveys: true,
    session_recording: {
      maskAllInputs: true,
      // Transcripts, diffs and file views hold the operator's code and prompts.
      // Masking all text keeps layout, clicks and errors replayable without them.
      maskTextSelector: "*"
    }
  })
  posthog.register({ app_version: __APP_VERSION__ })
}
