import { Schema } from "effect"

/** Every coding harness Jingler can discover, persist, and route work through. */
export const CliKind = Schema.Literal(
  "claude",
  "codex",
  "cursor",
  "opencode"
)
export type CliKind = Schema.Schema.Type<typeof CliKind>

/** Every harness kind, for exhaustive iteration and runtime input validation. */
export const CLI_KINDS: ReadonlyArray<CliKind> = CliKind.literals

/** Harnesses available for new workspaces and current production discovery. */
export const SupportedCliKind = Schema.Literal("claude", "codex")
export type SupportedCliKind = Schema.Schema.Type<typeof SupportedCliKind>
export const SUPPORTED_CLI_KINDS: ReadonlyArray<SupportedCliKind> = SupportedCliKind.literals

export const isSupportedCliKind = (cli: CliKind): cli is SupportedCliKind =>
  cli === "claude" || cli === "codex"
