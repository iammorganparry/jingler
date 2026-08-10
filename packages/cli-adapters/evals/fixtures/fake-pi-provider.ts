import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxResponseStep,
  type Provider
} from "@earendil-works/pi-ai"
import type { ModelRuntime } from "@earendil-works/pi-coding-agent"

export { fauxAssistantMessage, fauxToolCall }
export type FakePiResponse = FauxResponseStep

/** Deterministic in-memory pi-ai provider installed into the real ModelRuntime. */
export class FakePiProvider {
  readonly #provider
  readonly #runtimeProvider: Provider

  constructor(input?: {
    readonly providerId?: string
    readonly modelId?: string
    readonly oauth?: boolean
  }) {
    const providerId = input?.providerId ?? "jingler-fake"
    this.#provider = fauxProvider({
      provider: providerId,
      api: `${providerId}-api`,
      models: [{ id: input?.modelId ?? "eval-model" }],
      tokensPerSecond: 0
    })
    this.#runtimeProvider = input?.oauth
      ? {
          ...this.#provider.provider,
          auth: {
            ...this.#provider.provider.auth,
            oauth: {
              name: "Deterministic subscription",
              isSubscription: true,
              login: async () => {
                throw new Error("Deterministic login is supplied by AuthBroker")
              },
              refresh: async (credential) => credential,
              toAuth: async (credential) => ({ apiKey: credential.access })
            }
          }
        }
      : this.#provider.provider
  }

  get providerId(): string {
    return this.#provider.provider.id
  }

  get modelId(): string {
    return this.#provider.getModel().id
  }

  get callCount(): number {
    return this.#provider.state.callCount
  }

  setResponses(responses: ReadonlyArray<FakePiResponse>): void {
    this.#provider.setResponses([...responses])
  }

  install(runtime: ModelRuntime): void {
    runtime.registerNativeProvider(this.#runtimeProvider)
  }
}
