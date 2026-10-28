import { dag, Workspace, Directory, Container, object, func, check } from "@dagger.io/dagger"

const CI_ENV: Record<string, string> = {
  CI: "1",
  BETTER_AUTH_SECRET: "ci-only-better-auth-placeholder-at-least-32-bytes",
  BETTER_AUTH_URL: "https://ci.invalid",
  CRON_SECRET: "ci-only-cron-placeholder-at-least-32-bytes",
  VITEST_MAX_WORKERS: "4",
}

/** The Linux-safe steps of .github/workflows/ci.yml; Electron packaging stays on the macOS runner. */
@object()
export class Ci {
  source: Directory

  constructor(ws: Workspace) {
    this.source = ws.directory("/", {
      exclude: ["**/node_modules", "**/.git", "**/dist", "**/out", "**/.dagger", "**/.turbo", "**/test-results"],
    })
  }

  /** Node 24 + pnpm with deps installed. Manifests are copied first so the install layer survives source edits. */
  @func()
  base(): Container {
    const manifests = this.source.filter({ include: ["**/package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc", "patches/**"] })
    let ctr = dag
      .container()
      .from("node:24-bookworm-slim")
      .withExec(["sh", "-c", "apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*"])
      .withExec(["git", "config", "--global", "user.email", "ci@jingler.invalid"])
      .withExec(["git", "config", "--global", "user.name", "Jingler CI"])
      .withExec(["git", "config", "--global", "init.defaultBranch", "main"])
      .withExec(["corepack", "enable"])
      .withExec(["corepack", "prepare", "pnpm@10.7.0", "--activate"])
      // Non-root, like the CI runner: tests rely on chmod making paths unwritable, which root ignores.
      .withExec(["sh", "-c", "mkdir -p /src && chown node:node /src"])
      .withUser("node")
      .withMountedCache("/home/node/.local/share/pnpm/store", dag.cacheVolume("jingler-pnpm-store-node"), { owner: "node" })
      .withWorkdir("/src")
      .withDirectory("/src", manifests, { owner: "node" })
      .withExec(["pnpm", "install", "--frozen-lockfile", "--ignore-scripts"])
      .withDirectory("/src", this.source, { owner: "node" })
    for (const [k, v] of Object.entries(CI_ENV)) ctr = ctr.withEnvVariable(k, v)
    return ctr
  }

  private async run(...cmd: string[]): Promise<void> {
    await this.base().withExec(cmd).sync()
  }

  @func() @check() async lint(): Promise<void> { await this.run("pnpm", "lint") }
  /** Same steps as `pnpm typecheck`, but turbo capped at 2 parallel tsc runs: unbounded, they OOM an 8 GB engine (exit 137). */
  @func() @check() async typecheck(): Promise<void> {
    await this.base()
      .withExec(["pnpm", "version:check"])
      .withExec(["pnpm", "runtime-contracts:check"])
      .withExec(["pnpm", "exec", "turbo", "run", "typecheck", "--concurrency=2"])
      .sync()
  }
  @func() @check() async test(): Promise<void> { await this.run("pnpm", "test") }
  @func() @check() async piEval(): Promise<void> { await this.run("pnpm", "--filter", "@jingler/cli-adapters", "eval:pi:deterministic") }
  @func() @check() async licenses(): Promise<void> { await this.run("pnpm", "license:check") }
}
