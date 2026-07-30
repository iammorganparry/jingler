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
