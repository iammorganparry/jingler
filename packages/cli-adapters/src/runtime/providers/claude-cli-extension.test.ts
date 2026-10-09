import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { execFile } from "node:child_process"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it, vi } from "vitest"
import claudeCliProviderExtension, {
  hasClaudeCliCredential
} from "./claude-cli-extension.js"

const execFileAsync = promisify(execFile)
const roots: string[] = []
const originalAgentDir = process.env.PI_CODING_AGENT_DIR

afterEach(async () => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ))
})

const agentDir = async (credential: object): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "jingler-claude-child-extension-"))
  roots.push(root)
  await writeFile(join(root, "auth.json"), JSON.stringify({ anthropic: credential }))
  return root
}

describe("Claude CLI child provider extension", () => {
  it("loads through the unpackaged runtime asset", async () => {
    const root = await agentDir({
      type: "oauth",
      access: "claude-cli",
      refresh: ""
    })
    process.env.PI_CODING_AGENT_DIR = root
    const registerProvider = vi.fn()
    const wrapperPath = new URL(
      "../../../runtime-assets/jingler-claude-cli-provider.mjs",
      import.meta.url
    )
    const wrapper = await import(/* @vite-ignore */ wrapperPath.href) as {
      default: (pi: ExtensionAPI) => Promise<void>
    }

    await wrapper.default({ registerProvider } as unknown as ExtensionAPI)

    expect(registerProvider).toHaveBeenCalledOnce()
  })

  it("loads under the async runner's inherited JITI_ALIAS", async () => {
    // pi-subagents' detached runner exports JITI_ALIAS mapping the bare pi-ai
    // specifier to its compat entry. jiti prefix-matches aliases, so
    // `pi-ai/api/lazy` became `compat.js/api/lazy` and the Claude provider never
    // registered: async children fell back to HTTP Anthropic and got a 401.
    // A fresh process, because jiti's module cache would hide the alias here.
    const root = await agentDir({ type: "oauth", access: "claude-cli", refresh: "" })
    const wrapper = new URL("../../../runtime-assets/jingler-claude-cli-provider.mjs", import.meta.url).href
    const compat = fileURLToPath(new URL("../../../../../node_modules/@earendil-works/pi-ai/dist/compat.js", import.meta.url))
    const script = `const m = await import(${JSON.stringify(wrapper)}); const c = []; await m.default({ registerProvider: (n) => c.push(n) }); console.log(c.join(","))`
    const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, PI_CODING_AGENT_DIR: root, JITI_ALIAS: JSON.stringify({ "@earendil-works/pi-ai": compat }) }
    })

    expect(stdout.trim()).toBe("anthropic")
  }, 30_000)

  it("registers the CLI stream only for Jingler's non-secret route marker", async () => {
    const root = await agentDir({
      type: "oauth",
      access: "claude-cli",
      refresh: "",
      expires: Number.MAX_SAFE_INTEGER
    })
    process.env.PI_CODING_AGENT_DIR = root
    const registerProvider = vi.fn()

    claudeCliProviderExtension({ registerProvider } as unknown as ExtensionAPI)

    expect(hasClaudeCliCredential(root)).toBe(true)
    expect(registerProvider).toHaveBeenCalledOnce()
    expect(registerProvider).toHaveBeenCalledWith("anthropic", {
      api: "anthropic-messages",
      streamSimple: expect.any(Function),
      models: expect.any(Array)
    })
    // The child must know the same aliases as the parent, or pi-subagents
    // resolves `sonnet` to a concrete id and fails model verification.
    const ids = registerProvider.mock.calls[0]![1].models.map(({ id }: { id: string }) => id)
    expect(ids).toEqual(expect.arrayContaining(["sonnet", "opus", "haiku", "claude-sonnet-5"]))
  })

  it("does not replace Anthropic HTTP for an API credential", async () => {
    const root = await agentDir({ type: "api_key", key: "secret" })
    process.env.PI_CODING_AGENT_DIR = root
    const registerProvider = vi.fn()

    claudeCliProviderExtension({ registerProvider } as unknown as ExtensionAPI)

    expect(hasClaudeCliCredential(root)).toBe(false)
    expect(registerProvider).not.toHaveBeenCalled()
  })
})
