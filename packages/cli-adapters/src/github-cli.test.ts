import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import { GitHubCli } from "./github-cli.js"
import { fakeCommandExecutor } from "./test-support.js"

const run = <A>(effect: Effect.Effect<A, unknown, unknown>, handler: Parameters<typeof fakeCommandExecutor>[0]): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(Layer.mergeAll(GitHubCli.Default, fakeCommandExecutor(handler))) as never)) as Promise<A>

describe("GitHubCli", () => {
  it("detects an authenticated CLI", async () => {
    await expect(run(GitHubCli.available(), (command, args) => {
      if (command === "which") return { stdout: "/usr/local/bin/gh\n" }
      if (command === "gh" && args[0] === "auth") return { stdout: "github.com\n" }
      return
    })).resolves.toBe(true)
  })

  it("loads a PR and inline review threads through gh", async () => {
    const commands: Array<ReadonlyArray<string>> = []
    const result = await run(GitHubCli.prView("/repo", 42), (command, args) => {
      if (command !== "gh") return
      commands.push(args)
      if (args[0] === "pr") return { stdout: JSON.stringify({
        state: "OPEN",
        number: 42,
        title: "CLI first",
        url: "https://github.com/acme/widget/pull/42",
        author: { login: "octocat" },
        commits: [{ oid: "abc", messageHeadline: "ship it", authors: [{ login: "octocat" }] }]
      }) }
      if (args[0] === "repo") return { stdout: "acme/widget\n" }
      if (args[0] === "api") return { stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }) }
      return
    })

    expect(result).toMatchObject({ number: 42, title: "CLI first", commits: 1 })
    expect(result.commitItems?.[0]).toMatchObject({ sha: "abc", message: "ship it" })
    expect(commands.map((args) => args[0])).toEqual(["pr", "repo", "api"])
  })
})
