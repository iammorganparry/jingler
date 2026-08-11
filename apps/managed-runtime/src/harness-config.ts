export const managedCodexHome = "/tmp/jingler-codex"

/**
 * A named provider keeps Codex on authenticated HTTP Responses. The built-in
 * provider currently probes WebSockets first and omits its API-key bearer from
 * that upgrade request, which cannot satisfy the session-scoped proxy fence.
 * Keep this outside /workspace so it is neither checkpointed nor exposed as
 * repository state. The URL contains no credential; authorization remains the
 * short-lived bearer token supplied to the process.
 */
export const managedCodexConfig = (baseUrl: string): string =>
  [
    'model_provider = "jingler_managed"',
    "",
    "[model_providers.jingler_managed]",
    'name = "Jingler managed Codex"',
    `base_url = ${JSON.stringify(baseUrl)}`,
    'wire_api = "responses"',
    'env_key = "OPENAI_API_KEY"',
    "requires_openai_auth = true",
    "supports_websockets = false",
    ""
  ].join("\n")
