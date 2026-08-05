/**
 * The built-in `github` authentication provider.
 *
 * Plugins receive a short-lived GitHub App installation credential after
 * plugin consent. The credential stays in the trusted extension host and never
 * reaches the renderer or an agent. Relay WebSocket grants are a different
 * credential class and must never be returned as GitHub REST credentials.
 */
import { Effect } from "effect"
import type { AuthProvider, ProviderToken } from "./plugin-auth.js"
import { GitHubAuth } from "./github-auth.js"

const GITHUB_API_URL = "https://api.github.com"

const repositoryScope = (
  scopes: ReadonlyArray<string>
): { readonly owner: string; readonly fullName: string } | null => {
  const repository = scopes.find((scope) => scope.startsWith("repository:"))
  if (!repository) return null
  const fullName = repository.slice("repository:".length)
  const parts = fullName.split("/")
  return parts.length === 2 && parts[0] && parts[1]
    ? { owner: parts[0], fullName }
    : null
}

/** Build the ordinary consent-gated GitHub provider used by PluginAuth. */
export const makeGithubAuthProvider = (
  provide: <A, E>(effect: Effect.Effect<A, E, GitHubAuth>) => Promise<A>
): AuthProvider => ({
  id: "github",
  label: "GitHub",
  getToken: (scopes) =>
    Effect.promise(async (): Promise<ProviderToken | null> => {
      const repository = repositoryScope(scopes)
      const permissions = scopes.filter((scope) => !scope.startsWith("repository:"))
      if (!repository || permissions.length === 0) return null
      const status = await provide(GitHubAuth.status())
      const installation = status.installations.find(
        (candidate) =>
          candidate.status === "active" &&
          candidate.account.login.toLowerCase() === repository.owner.toLowerCase()
      )
      if (!installation) return null
      const credential = await provide(
        GitHubAuth.credentialsForOwner(repository.owner, repository.fullName, permissions)
      )
      return {
        accessToken: credential.token,
        account: status.user?.login ?? installation.account.login,
        apiBaseUrl: GITHUB_API_URL,
        expiresAt: credential.expiresAt
      }
    })
})
