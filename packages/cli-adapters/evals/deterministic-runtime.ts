import {
  CURRENT_RUNTIME_CONTRACTS,
  ProviderConnection,
  type AuthKind,
  type ProviderConnection as ProviderConnectionType
} from "@jingler/core"
import { Effect, Schema } from "effect"
import { InMemoryProviderCredentialStore } from "../src/runtime/auth/credential-store.js"
import { scriptedPiScenarioResponses } from "../src/runtime/certification/pi-scenario-fixture.js"
import { runPiScenario } from "../src/runtime/certification/pi-scenario-runner.js"
import {
  FakePiProvider
} from "./fixtures/fake-pi-provider.js"

const authKindFor = (scenarioId: string): AuthKind =>
  scenarioId === "auth.route-pinned" ? "openai-codex-oauth" : "api-key"

const connectionFor = (
  fake: FakePiProvider,
  authKind: AuthKind
): ProviderConnectionType =>
  Schema.decodeUnknownSync(ProviderConnection)({
    id: `eval-${authKind}`,
    providerId: fake.providerId,
    authKind,
    account: { fingerprint: "eval-account", displayLabel: "Deterministic" },
    targetId: "desktop",
    status: "authenticated",
    subscription: {
      entitlement: "active",
      planLabel: "Deterministic",
      expiresAt: null,
      quotaLabel: null,
      rateLimitLabel: null,
      confirmedBillingRoute: authKind === "api-key" ? "api" : "subscription"
    },
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z"
  })

const credentialsFor = async (
  connection: ProviderConnectionType,
  authKind: AuthKind
): Promise<InMemoryProviderCredentialStore> => {
  const credentials = new InMemoryProviderCredentialStore()
  await Effect.runPromise(
    credentials.write({
      connectionId: connection.id,
      authKind,
      access: "deterministic-credential",
      refresh: authKind === "openai-codex-oauth" ? "deterministic-refresh" : null,
      expiresAt: authKind === "openai-codex-oauth" ? Date.now() + 60 * 60_000 : null
    })
  )
  return credentials
}

export { runPiScenario }

export const runDeterministicScenario = async (scenarioId: string) => {
  const authKind = authKindFor(scenarioId)
  const fake = new FakePiProvider({ oauth: authKind === "openai-codex-oauth" })
  fake.setResponses(scriptedPiScenarioResponses(scenarioId))
  const connection = connectionFor(fake, authKind)
  const credentials = await credentialsFor(connection, authKind)
  return runPiScenario({
    scenarioId,
    connection,
    credentials,
    target: {
      providerId: fake.providerId,
      modelId: fake.modelId,
      capabilities: {
        versions: CURRENT_RUNTIME_CONTRACTS,
        toolIds: [],
        resourceIds: [],
        targetId: "desktop"
      }
    },
    configureModelRuntime: (runtime) => fake.install(runtime)
  })
}
