import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it, vi } from "vitest"
import claudeCliProviderExtension, {
  hasClaudeCliCredential
} from "./claude-cli-extension.js"

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
      streamSimple: expect.any(Function)
    })
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
