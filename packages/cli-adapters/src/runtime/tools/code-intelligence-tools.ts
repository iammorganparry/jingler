import { Schema } from "effect"
import type { ToolDefinition, ToolRegistry } from "./tool-registry.js"
import {
  codeDefinitions,
  codeDiagnostics,
  codeHover,
  semanticReferences,
  semanticRename
} from "./typescript-analysis.js"

export const codeReadRoles = ["conversation", "plan", "plan-execution", "review", "background"] as const
export const codeWriteRoles = ["conversation", "plan-execution", "background"] as const
export const codeReadModes = ["ask", "accept-edits", "auto", "plan", "read-only"] as const
export const codeWriteModes = ["ask", "accept-edits", "auto"] as const
const SymbolInput = {
  file: Schema.String.pipe(Schema.minLength(1)),
  symbol: Schema.String.pipe(Schema.minLength(1)),
  line: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(1)),
  column: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(1)))
}

const readTool = <Input, Encoded>(definition: Pick<ToolDefinition<Input, Encoded>, "id" | "description" | "input" | "execute">): ToolDefinition<Input, Encoded> => ({
  ...definition,
  version: "1",
  risk: "read",
  roles: codeReadRoles,
  modes: codeReadModes,
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
    execute: (input, context) => {
      switch (input.action) {
        case "definitions": return codeDefinitions(cwd, input.file, input.symbol, input.line, input.column, context.signal)
        case "references": return semanticReferences(cwd, input.file, input.symbol, input.line, input.column, context.signal)
        case "hover": return codeHover(cwd, input.file, input.symbol, input.line, input.column, context.signal)
        case "diagnostics": return codeDiagnostics(cwd, input.file, context.signal)
      }
    }
  }))
  registry.register({
    id: "code_rename",
    version: "1",
    description: "Rename one resolved TypeScript/JavaScript symbol across semantic references with staged writes and rollback on failure. Use code_intelligence references first.",
    input: Schema.Struct({ ...SymbolInput, newName: Schema.String.pipe(Schema.minLength(1)) }),
    risk: "mutate",
    roles: codeWriteRoles,
    modes: codeWriteModes,
    timeoutMs: 30_000,
    outputBudget: 16_000,
    cancellable: false,
    idempotency: "keyed",
    execute: ({ file, symbol, line, column, newName }, context) =>
      semanticRename(cwd, file, symbol, line, column, newName, context.signal)
  })
}
