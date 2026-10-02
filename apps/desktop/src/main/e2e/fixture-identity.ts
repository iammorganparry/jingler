export const E2E_PI_PROVIDER_ID = "jingler-e2e"
export const E2E_PI_MODEL_ID = "jingler-e2e/eval-model"
export const E2E_PI_CONNECTION_ID = "jingler-e2e-connection"
export const E2E_CLAUDE_PROVIDER_ID = "anthropic"
export const E2E_CLAUDE_MODEL_ID = "anthropic/claude-fable-5"

export const e2ePiIdentity = (scenarioId: string) =>
  scenarioId === "named-mcp"
    ? {
        connectionId: E2E_PI_CONNECTION_ID,
        providerId: E2E_CLAUDE_PROVIDER_ID,
        modelId: E2E_CLAUDE_MODEL_ID
      }
    : scenarioId === "pi-codex-cli-models"
      ? {
          connectionId: E2E_PI_CONNECTION_ID,
          providerId: "openai-codex",
          modelId: "openai-codex/gpt-6.1-sol"
        }
    : {
        connectionId: E2E_PI_CONNECTION_ID,
        providerId: E2E_PI_PROVIDER_ID,
        modelId: E2E_PI_MODEL_ID
      }
