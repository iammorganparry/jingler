import type { AgentRole, RuntimeMode } from "@jingler/core"
import type { PromptToolCapability } from "../prompt/prompt-compiler.js"
import { nativeCliEnvironment, withMacCliPath } from "./native-cli-environment.js"

/**
 * Claude Code leaves its `Artifact` tool out of `-p` sessions unless opted in
 * (verified on 2.1.286). Auto-open is off because Jingler opens the link in its
 * own preview dock rather than the system browser.
 */
export const claudeArtifactEnvironment = {
  CLAUDE_CODE_ARTIFACT: "1",
  CLAUDE_CODE_ARTIFACT_AUTO_OPEN: "0"
} as const

/**
 * Publishing sends local content to claude.ai, so it follows the same rule as
 * every mutating Jingler tool: never in plan, read-only or review runs.
 */
export const claudeArtifactsAllowed = (role: AgentRole, mode: RuntimeMode): boolean =>
  (role === "conversation" || role === "plan-execution") && mode !== "plan" && mode !== "read-only"

/**
 * `Read` must be enabled because `Artifact` refuses to publish under the deny
 * rule the CLI adds when `--tools` omits it; an MCP read does not satisfy it.
 * It is deliberately NOT in `--allowedTools`: unapproved, Claude Code confines
 * Read to the working directory and `--permission-prompts none` refuses the
 * rest (verified on 2.1.286: worktree file read, /etc/hosts denied).
 */
export const claudeToolArguments = (artifacts: boolean): ReadonlyArray<string> => artifacts
  ? ["--tools", "Artifact,Read", "--allowedTools", "mcp__jingler__* Artifact"]
  : ["--tools", "", "--allowedTools", "mcp__jingler__*"]

/**
 * Setting-source, tool and strict-MCP flags. `--strict-mcp-config` and empty
 * setting sources both drop claude.ai connectors, so a non-null
 * `claudeConnectorSettings` overlay switches to user settings and allows
 * `mcp__claude_ai_*` tools.
 */
export const claudeConnectorArguments = (
  connectorSettings: string | null,
  tools: ReadonlyArray<string>
): { readonly sources: ReadonlyArray<string>; readonly tools: ReadonlyArray<string>; readonly strict: ReadonlyArray<string> } =>
  connectorSettings === null
    ? { sources: ["--setting-sources", ""], tools, strict: ["--strict-mcp-config"] }
    : {
        sources: ["--setting-sources", "user", "--settings", connectorSettings],
        // ToolSearch keeps connector schemas out of the prompt until needed (an enterprise org inherits dozens).
        tools: tools.map((arg, index) => {
          if (tools[index - 1] === "--tools") return arg === "" ? "ToolSearch" : `${arg},ToolSearch`
          return tools[index - 1] === "--allowedTools" ? `${arg} mcp__claude_ai_* ToolSearch` : arg
        }),
        strict: []
      }

/** Listed in the compiled active-tools catalog so the prompt agrees with the CLI flags. */
export const claudeArtifactCapability: PromptToolCapability = {
  id: "Artifact",
  version: "1",
  description: "Claude Code built-in, called as `Artifact` (not mcp__jingler__Artifact). Publishes an HTML or Markdown file as a private claude.ai page the operator can share from its Share menu. Write the page inside the worktree with workspace_write, read it with the built-in `Read` (Artifact refuses files Read has not seen; Read only reaches the worktree), then publish with its file_path. To update, publish again passing the earlier artifact URL as `url`. Always show the operator the returned URL."
}

/** The URL in Artifact's publish result: `Published <path> at https://claude.ai/artifact/<id> (Version n, …)`. */
const PUBLISHED_ARTIFACT = /Published .+? at (https:\/\/claude\.ai\/(?:code\/)?artifact\/[\w-]+)/u

export const publishedArtifactUrl = (text: string): string | null => PUBLISHED_ARTIFACT.exec(text)?.[1] ?? null

export const withClaudeCliPath = (
  environment: NodeJS.ProcessEnv,
  platform = process.platform
): NodeJS.ProcessEnv => withMacCliPath(environment, platform)

export const claudeCliEnvironment = (
  environment: NodeJS.ProcessEnv,
  platform = process.platform
): NodeJS.ProcessEnv => ({
  ...nativeCliEnvironment(withClaudeCliPath(environment, platform)),
  ...claudeArtifactEnvironment
})
