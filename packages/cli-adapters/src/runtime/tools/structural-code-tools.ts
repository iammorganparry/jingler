import { Schema } from "effect"
import type { ToolRegistry } from "./tool-registry.js"
import { codeReadModes, codeReadRoles, codeWriteModes, codeWriteRoles } from "./code-intelligence-tools.js"
import { applyIdentifierEdits, structuralPreview } from "./typescript-analysis.js"

const PREVIEW_TOKEN = /^[a-f0-9]{64}$/u
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
    roles: codeReadRoles,
    modes: codeReadModes,
    timeoutMs: 30_000,
    outputBudget: 32_000,
    cancellable: false,
    idempotency: "safe",
    execute: ({ symbol, kind }, context) => structuralPreview(cwd, symbol, kind, context.signal)
  })
  registry.register({
    id: "structural_edit",
    version: "1",
    description: "Apply a previewed syntax-aware identifier replacement. Pass previewToken from structural_search so moved or changed matches fail closed.",
    input: Schema.Struct({
      ...MatchInput,
      newName: Schema.String.pipe(Schema.minLength(1)),
      previewToken: Schema.String.pipe(Schema.pattern(PREVIEW_TOKEN))
    }),
    risk: "mutate",
    roles: codeWriteRoles,
    modes: codeWriteModes,
    timeoutMs: 30_000,
    outputBudget: 16_000,
    cancellable: false,
    idempotency: "keyed",
    execute: async ({ symbol, kind, newName, previewToken }, context) => {
      const preview = await structuralPreview(cwd, symbol, kind, context.signal)
      if (preview.value.previewToken !== previewToken) throw new Error("Structural preview is stale; run structural_search again")
      return applyIdentifierEdits(cwd, preview.value.matches, symbol, newName, {
        preview: { kind, token: previewToken }
      })
    }
  })
}
