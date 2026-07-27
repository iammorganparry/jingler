/**
 * The built-in `github` authentication provider.
 *
 * ## Why this is a provider and not a shortcut
 *
 * Jingler already has GitHub credentials — the `gh` CLI is authenticated, and
 * `GhService` shells out to it constantly. The tempting thing is to let plugins
 * reach that directly, or to special-case the official PR plugin.
 *
 * Neither happens. GitHub is registered as an ordinary {@link AuthProvider}, so
 * a plugin reaches it through exactly the `getSession("github", [...])` call it
 * would use for a provider some other plugin contributed. That is what makes the
 * claim in the docs true: the official GitHub plugin holds no privilege a
 * third-party GitHub plugin could not also request, and the operator's consent
 * is required for both.
 *
 * ## Why the token comes from `gh auth token`
 *
 * Jingler does not run its own GitHub OAuth app, and adding one would mean
 * asking every operator to authorise a second thing when they have already
 * authorised `gh`. Borrowing `gh`'s token means the account a plugin acts as is
 * visibly the same account the rest of the app acts as — which is what the
 * operator will assume anyway, so it had better be true.
 *
 * The scopes a plugin asks for are therefore a statement of intent recorded in
 * the grant, not a restriction enforced on the token: `gh`'s token has whatever
 * scopes it has. The consent prompt says what is being asked for and the grant
 * records it; `plugin-auth.ts`'s header does not pretend otherwise.
 */
import type { CommandExecutor } from "@effect/platform"
import { Effect } from "effect"
import type { AuthProvider, ProviderToken } from "./plugin-auth.js"
import { runString } from "./command.js"

/** `gh <args>`, folding every failure to null. See `getToken`'s note. */
const gh = (
  ...args: ReadonlyArray<string>
): Effect.Effect<string | null, never, CommandExecutor.CommandExecutor> =>
  runString("gh", ...args)

/**
 * Build the provider.
 *
 * `getToken` never fails — a missing `gh`, an unauthenticated `gh`, or a
 * non-zero exit all resolve to `null`, which `PluginAuth` turns into "no
 * session". A plugin that asked for GitHub and got nothing back should degrade,
 * not see a stack trace about a binary it never mentioned.
 */
export const makeGithubAuthProvider = (
  /**
   * Runs an effect needing a `CommandExecutor`. Injected because `AuthProvider`
   * is deliberately requirement-free — a provider contributed by a plugin has
   * no Effect context at all, and the built-in one must not be the odd shape.
   */
  provide: <A>(effect: Effect.Effect<A, never, CommandExecutor.CommandExecutor>) => Promise<A>
): AuthProvider => ({
  id: "github",
  label: "GitHub",
  getToken: () =>
    Effect.promise(async (): Promise<ProviderToken | null> => {
      const token = await provide(gh("auth", "token"))
      if (!token) return null
      // The login is fetched separately and is optional: it is only shown in
      // Settings so the operator can see WHICH account a plugin holds, and
      // failing the whole grant because a second call was slow would be a poor
      // trade for a label.
      const login = await provide(gh("api", "user", "--jq", ".login"))
      return login ? { accessToken: token, account: login } : { accessToken: token }
    })
})
