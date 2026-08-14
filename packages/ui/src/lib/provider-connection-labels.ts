import type { AuthKind, AuthStatus } from "@jingler/core"

export const providerAuthRouteLabel = (authKind: AuthKind): string => {
  switch (authKind) {
    case "claude-setup-token":
      return "Claude Pro / Max setup-token"
    case "openai-codex-oauth":
      return "ChatGPT Codex subscription"
    case "api-key":
      return "Provider API key"
    case "device-environment":
      return "Execution-device environment"
  }
}

export const providerStatusTone = (status: AuthStatus): string =>
  status === "authenticated"
    ? "bg-green"
    : status === "connecting"
      ? "bg-yellow"
      : "bg-red"
