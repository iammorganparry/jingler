import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { createClaudeCliStreamSimple } from "./claude-cli-provider.js"

interface PiAuthFile {
  readonly anthropic?: {
    readonly type?: unknown
    readonly access?: unknown
    readonly refresh?: unknown
  }
}

export const hasClaudeCliCredential = (agentDir: string): boolean => {
  try {
    const auth = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8")) as PiAuthFile
    return auth.anthropic?.type === "oauth" &&
      auth.anthropic.access === "claude-cli" &&
      auth.anthropic.refresh === ""
  } catch {
    return false
  }
}

export default function claudeCliProviderExtension(pi: ExtensionAPI): void {
  const agentDir = process.env.PI_CODING_AGENT_DIR
  if (agentDir === undefined || !hasClaudeCliCredential(agentDir)) return
  pi.registerProvider("anthropic", {
    api: "anthropic-messages",
    streamSimple: createClaudeCliStreamSimple()
  })
}
