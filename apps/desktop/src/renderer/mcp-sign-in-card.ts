import type { McpAuthState } from "@jingler/core"

/** What this window did since the operator last pressed Connect for a server. */
export type McpSignInAttempt = "waiting" | "failed" | "cancelled"

export type McpSignInPhase = "needs-sign-in" | "waiting" | "connected" | "failed" | "hidden"

/** Pure mapping from the server's auth state plus the local attempt to the card's phase. */
export const mcpSignInPhase = (authState: McpAuthState, attempt: McpSignInAttempt | undefined): McpSignInPhase => {
  if (attempt === "failed") return "failed"
  if (authState === "ready" || authState === "not-required") return attempt === "waiting" ? "connected" : "hidden"
  if (attempt === "cancelled") return "needs-sign-in"
  return authState === "authorizing" || attempt === "waiting" ? "waiting" : "needs-sign-in"
}
