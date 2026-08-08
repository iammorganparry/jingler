import type { CliInfo, Repo } from "@jingler/core"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { discoverDeviceCapabilities, ensureDeviceWorkspaceConfig } from "./capabilities.js"

const cli = (kind: CliInfo["kind"], available: boolean): CliInfo => ({
  kind,
  label: kind,
  binPath: available ? `/bin/${kind}` : null,
  version: available ? "1.0.0" : null,
  available,
  backgroundTasks: false,
  contextReporting: false
})

const repo: Repo = {
  name: "jingler",
  path: "/repos/jingler",
  defaultBranch: "main",
  currentBranch: "feat/device-agent",
  remoteUrl: "git@github.com:iammorganparry/jingler.git",
  githubSlug: "iammorganparry/jingler"
}

describe("device capabilities", () => {
  it("seeds a fresh device from the conventional repos directory", async () => {
    const home = mkdtempSync(join(tmpdir(), "jingler-device-home-"))
    const root = join(home, "jingler")
    mkdirSync(join(home, "repos"), { recursive: true })

    await ensureDeviceWorkspaceConfig(root, home)

    expect(JSON.parse(readFileSync(join(root, "config.json"), "utf8"))).toMatchObject({
      reposDir: join(home, "repos")
    })
  })
  it("discovers installed harnesses repositories and branches", async () => {
    const result = await Effect.runPromise(
      discoverDeviceCapabilities(
        {
          harnesses: () => Effect.succeed([cli("codex", true), cli("claude", false)]),
          repositories: () => Effect.succeed([repo]),
          branches: () => Effect.succeed(["main", "feat/device-agent"]),
          platform: () => ({ os: "darwin", arch: "arm64" })
        },
        "2.0.3"
      )
    )
    expect(result.capabilities.harnesses).toStrictEqual(["codex"])
    expect(result.repositories).toStrictEqual([
      expect.objectContaining({
        name: "jingler",
        branches: ["main", "feat/device-agent"],
        githubSlug: "iammorganparry/jingler"
      })
    ])
  })

  it("keeps discovery available when one repository branch probe fails", async () => {
    const result = await Effect.runPromise(
      discoverDeviceCapabilities(
        {
          harnesses: () => Effect.succeed([cli("codex", true)]),
          repositories: () => Effect.succeed([repo]),
          branches: () => Effect.fail("git unavailable"),
          platform: () => ({ os: "linux", arch: "x64" })
        },
        "2.0.3"
      )
    )
    expect(result.repositories).toStrictEqual([])
  })

  it("excludes an unborn repository that cannot create a worktree", async () => {
    const result = await Effect.runPromise(
      discoverDeviceCapabilities(
        {
          harnesses: () => Effect.succeed([cli("claude", true)]),
          repositories: () =>
            Effect.succeed([
              { ...repo, defaultBranch: "HEAD", currentBranch: "HEAD" }
            ]),
          branches: () => Effect.succeed([]),
          platform: () => ({ os: "darwin", arch: "arm64" })
        },
        "2.0.3"
      )
    )
    expect(result.repositories).toStrictEqual([])
  })
})
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
