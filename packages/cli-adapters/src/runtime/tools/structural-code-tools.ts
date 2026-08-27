import { Schema } from "effect"
import type { ToolRegistry } from "./tool-registry.js"
import { applyIdentifierEdits, structuralMatches } from "./typescript-analysis.js"

const readRoles = ["conversation", "plan", "plan-execution", "review", "background"] as const
const writeRoles = ["conversation", "plan-execution", "background"] as const
const readModes = ["ask", "accept-edits", "auto", "plan", "read-only"] as const
const writeModes = ["ask", "accept-edits", "auto"] as const
const MatchInput = {
  symbol: Schema.String.pipe(Schema.minLength(1)),
  kind: Schema.Literal("identifier", "call")
}

export const registerStructuralCodeTools = (registry: ToolRegistry, cwd: string): void => {
  registry.register({
    id: "structural_search",
    version: "1",
    description: "Find TypeScript/JavaScript identifiers or direct function calls by syntax, excluding comments and string contents.",
    input: Schema.Struct(MatchInput),
    risk: "read",
    roles: readRoles,
    modes: readModes,
    timeoutMs: 30_000,
    outputBudget: 32_000,
    cancellable: true,
    idempotency: "safe",
    execute: ({ symbol, kind }) => Promise.resolve(structuralMatches(cwd, symbol, kind))
  })
  registry.register({
    id: "structural_edit",
    version: "1",
    description: "Apply a previewed syntax-aware identifier replacement. Pass expectedMatches from structural_search so stale files fail closed.",
    input: Schema.Struct({
      ...MatchInput,
      newName: Schema.String.pipe(Schema.minLength(1)),
      expectedMatches: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(1))
    }),
    risk: "mutate",
    roles: writeRoles,
    modes: writeModes,
    timeoutMs: 30_000,
    outputBudget: 16_000,
    cancellable: false,
    idempotency: "keyed",
    execute: async ({ symbol, kind, newName, expectedMatches }) => {
      const matches = structuralMatches(cwd, symbol, kind)
      if (matches.value.length !== expectedMatches) throw new Error(`Structural preview is stale: expected ${expectedMatches}, found ${matches.value.length}`)
      return applyIdentifierEdits(cwd, matches.value, symbol, newName)
    }
  })
}
