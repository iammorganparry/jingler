import {
  type SetWebSearchCredentialInput,
  type WebSearchCredentialStatus,
  WebSearchError,
  type WebSearchProvider
} from "@jingler/core"
import { Effect } from "effect"
import { AgentSecretStore } from "./runtime/auth/agent-secret-store.js"
import { SecretStore } from "./secret-store.js"

const credentialError = (message: string, retryable = false) =>
  new WebSearchError({ reason: "unavailable", message, retryable })

/**
 * Main-process credential boundary for EXA/Firecrawl. Reads expose only status;
 * raw keys are available solely to trusted search/synchronization services.
 */
export class WebSearchCredentialService extends Effect.Service<WebSearchCredentialService>()(
  "@jingler/WebSearchCredentialService",
  {
    accessors: true,
    effect: Effect.gen(function* () {
      const secretStore = yield* SecretStore
      const credentials = new AgentSecretStore(secretStore)
      const authBaseUrl = () =>
        process.env.JINGLER_AUTH_URL ?? "http://localhost:9100"

      const syncCloud = (
        provider: WebSearchProvider,
        apiKey: string | null
      ): Effect.Effect<boolean> =>
        Effect.gen(function* () {
          const token = yield* secretStore.get
          if (token === null) return false
          return yield* Effect.tryPromise(() =>
            fetch(`${authBaseUrl()}/api/environments/web-search-credential`, {
              method: apiKey === null ? "DELETE" : "PUT",
              headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json"
              },
              body: JSON.stringify({
                provider,
                ...(apiKey === null ? {} : { apiKey })
              })
            })
          ).pipe(
            Effect.map((response) => response.ok),
            Effect.orElseSucceed(() => false)
          )
        })

      const resolve = (provider: WebSearchProvider) =>
        credentials.readWebSearch(provider).pipe(
          Effect.mapError(() => credentialError("Could not read WebSearch credentials"))
        )

      const statusFor = (provider: WebSearchProvider): Effect.Effect<
        WebSearchCredentialStatus,
        WebSearchError
      > =>
        resolve(provider).pipe(
          Effect.map((credential) => ({
            provider,
            configured: credential !== null,
            cloudSynced: credential?.cloudSynced ?? false,
            validatedAt: credential?.validatedAt ?? null
          }))
        )

      return {
        status: Effect.all([
          statusFor("exa"),
          statusFor("firecrawl")
        ]),
        resolveKey: (provider: WebSearchProvider) =>
          resolve(provider).pipe(Effect.map((credential) => credential?.apiKey ?? null)),
        set: (input: SetWebSearchCredentialInput) =>
          credentials.writeWebSearch(input.provider, {
            apiKey: input.apiKey,
            validatedAt: null,
            cloudSynced: false
          }).pipe(
            Effect.mapError(() => credentialError("Could not save WebSearch credentials")),
            Effect.zipRight(syncCloud(input.provider, input.apiKey)),
            Effect.flatMap((cloudSynced) =>
              credentials.writeWebSearch(input.provider, {
                apiKey: input.apiKey,
                validatedAt: null,
                cloudSynced
              }).pipe(
                Effect.mapError(() =>
                  credentialError("Could not update WebSearch sync status")
                )
              )
            ),
            Effect.zipRight(statusFor(input.provider))
          ),
        markValidated: (
          provider: WebSearchProvider,
          options: { readonly cloudSynced: boolean; readonly validatedAt?: string }
        ) =>
          resolve(provider).pipe(
            Effect.flatMap((credential) =>
              credential === null
                ? Effect.fail(credentialError("WebSearch credential is not configured"))
                : credentials.writeWebSearch(provider, {
                    ...credential,
                    validatedAt: options.validatedAt ?? new Date().toISOString(),
                    cloudSynced: options.cloudSynced
                  }).pipe(
                    Effect.mapError(() =>
                      credentialError("Could not update WebSearch credential status")
                    ),
                    Effect.zipRight(statusFor(provider))
                  )
            )
          ),
        clear: (provider: WebSearchProvider) =>
          syncCloud(provider, null).pipe(
            Effect.zipRight(credentials.deleteWebSearch(provider)),
            Effect.mapError(() => credentialError("Could not clear WebSearch credentials"))
          )
      }
    })
  }
) {}
