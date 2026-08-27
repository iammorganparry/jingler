import { Schema } from "effect"
import type { ToolDefinition, ToolRegistry } from "./tool-registry.js"
import {
  applyIdentifierEdits,
  codeDefinitions,
  codeDiagnostics,
  codeHover,
  semanticReferences
} from "./typescript-analysis.js"

const readRoles = ["conversation", "plan", "plan-execution", "review", "background"] as const
const writeRoles = ["conversation", "plan-execution", "background"] as const
const readModes = ["ask", "accept-edits", "auto", "plan", "read-only"] as const
const writeModes = ["ask", "accept-edits", "auto"] as const
const SymbolInput = {
  file: Schema.String.pipe(Schema.minLength(1)),
  symbol: Schema.String.pipe(Schema.minLength(1)),
  line: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(1))
}

const readTool = <Input, Encoded>(definition: Pick<ToolDefinition<Input, Encoded>, "id" | "description" | "input" | "execute">): ToolDefinition<Input, Encoded> => ({
  ...definition,
  version: "1",
  risk: "read",
  roles: readRoles,
  modes: readModes,
  timeoutMs: 30_000,
  outputBudget: 32_000,
  cancellable: false,
  idempotency: "safe"
})

export const registerCodeIntelligenceTools = (registry: ToolRegistry, cwd: string): void => {
  registry.register(readTool({
    id: "code_intelligence",
    description: "Use TypeScript semantic intelligence for definitions, references, hover types, or compiler diagnostics. Prefer this over text search when tracing symbols.",
    input: Schema.Union(
      Schema.Struct({ action: Schema.Literal("definitions", "references", "hover"), ...SymbolInput }),
      Schema.Struct({ action: Schema.Literal("diagnostics"), file: Schema.optional(Schema.String) })
    ),
    execute: (input) => Promise.resolve((() => {
      switch (input.action) {
        case "definitions": return codeDefinitions(cwd, input.file, input.symbol, input.line)
        case "references": return semanticReferences(cwd, input.file, input.symbol, input.line)
        case "hover": return codeHover(cwd, input.file, input.symbol, input.line)
        case "diagnostics": return codeDiagnostics(cwd, input.file)
      }
    })())
  }))
  registry.register({
    id: "code_rename",
    version: "1",
    description: "Rename one resolved TypeScript/JavaScript symbol across semantic references with staged writes and rollback on failure. Use code_intelligence references first.",
    input: Schema.Struct({ ...SymbolInput, newName: Schema.String.pipe(Schema.minLength(1)) }),
    risk: "mutate",
    roles: writeRoles,
    modes: writeModes,
    timeoutMs: 30_000,
    outputBudget: 16_000,
    cancellable: false,
    idempotency: "keyed",
    execute: async ({ file, symbol, line, newName }) => {
      const references = semanticReferences(cwd, file, symbol, line)
      return applyIdentifierEdits(cwd, references.value, symbol, newName)
    }
  })
}
