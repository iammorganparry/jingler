/**
 * The server's Effect runtime. `AppLayer` wires the `Database` service and every
 * Repository built on it; Hono handlers run Effects through `runtime.runPromise`.
 * A single `ManagedRuntime` is reused across requests (and across warm Vercel
 * invocations), mirroring the module-scoped Drizzle client.
 *
 * Add a repository: build it here (`provideMerge` its `.Default`) and it becomes
 * available to every handler.
 */
import { Layer, ManagedRuntime } from "effect"
import { Database } from "./db/database.js"
import { PersonalAccessTokenRepository } from "./db/repositories/personal-access-token-repository.js"
import { GitHubConnectionRepository } from "./db/repositories/github-connection-repository.js"
import { GitHubSessionRouteRepository } from "./db/repositories/github-session-route-repository.js"
import { UserRepository } from "./db/repositories/user-repository.js"

const AppLayer = Layer.mergeAll(
  UserRepository.Default,
  PersonalAccessTokenRepository.Default,
  GitHubConnectionRepository.Default,
  GitHubSessionRouteRepository.Default
).pipe(Layer.provideMerge(Database.Default))

export const runtime = ManagedRuntime.make(AppLayer)
