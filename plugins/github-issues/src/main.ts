/**
 * The host half: fetching an issue from GitHub.
 *
 * ## Why this is not in the UI half
 *
 * It cannot be. The renderer's CSP does not widen `connect-src`, so a plugin's
 * tab has no route to the network however much code it runs. Anything outbound
 * goes through the extension host, which is where the operator's consent is
 * recorded and revocable — and that constraint is the reason the split exists
 * rather than an inconvenience it imposes.
 *
 * ## No shortcut for being official
 *
 * Jingler already has GitHub credentials and this plugin ships with the app,
 * so it would be easy to hand it a token directly. It asks for one instead,
 * through the same `getSession("github", …)` a plugin someone wrote this
 * afternoon would use, and the operator sees the same prompt. That is the whole
 * claim in `AGENTS.md` — that the official plugin holds no privilege a
 * third-party one could not also request — and it is only true because this file
 * does the boring thing.
 */
import type { Activate } from "@jingler/plugin-sdk/host"

/** What the UI half asks for. */
interface FetchArgs {
  readonly repo: string
  readonly issueNumber: number
}

/**
 * The fields the tab renders.
 *
 * Requested explicitly rather than fetching everything: `gh issue view` will
 * happily return a payload several times this size, and a field this plugin does
 * not name is a field it cannot come to depend on by accident.
 */
const FIELDS = [
  "number",
  "title",
  "body",
  "state",
  "url",
  "author",
  "labels",
  "assignees",
  "comments",
  "createdAt",
  "updatedAt"
].join(",")

export const activate: Activate = (ctx) => {
  ctx.subscriptions.push(
    ctx.commands.register("github-issues.fetch", async (input) => {
      const { repo, issueNumber } = input as FetchArgs

      // Prompting is the default, so this resolves to a session or rejects if
      // the operator declines. The tab shows the rejection rather than an empty
      // issue, which is the honest thing: "you said no" and "GitHub returned
      // nothing" are different states and should not look the same.
      const session = await ctx.authentication.getSession("github", ["repo"])

      const result = await ctx.exec(
        "gh",
        ["issue", "view", String(issueNumber), "--repo", repo, "--json", FIELDS],
        {
          // The token is passed explicitly rather than relying on whatever `gh`
          // happens to be logged into. The grant the operator approved is the
          // account this runs as — if those two could differ, the consent prompt
          // would be describing something other than what happens.
          env: { GH_TOKEN: session.accessToken },
          timeoutMs: 15_000
        }
      )

      if (result.code !== 0) {
        // `gh`'s own stderr, verbatim. It says things like "could not resolve to
        // an Issue with the number 4321", which is exactly what the operator
        // needs and strictly more than "failed to load".
        throw new Error(result.stderr.trim() || `gh exited with code ${result.code}`)
      }

      return JSON.parse(result.stdout) as unknown
    })
  )

  ctx.log.info("GitHub Issues ready")
}
