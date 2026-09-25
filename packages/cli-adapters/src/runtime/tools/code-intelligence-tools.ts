import { Schema } from "effect"
import { codeReadModes, codeReadRoles, codeWriteModes, codeWriteRoles } from "./tool-registry.js"
import type { ToolDefinition, ToolRegistry } from "./tool-registry.js"
import {
  codeDefinitions,
  codeDiagnostics,
  semanticReferences,
  semanticRename
} from "./typescript-analysis.js"
import { languageHover } from "./language-intelligence.js"

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
    description: "Use semantic intelligence for TypeScript definitions, references, diagnostics, and TypeScript or Java hover types. Prefer this over text search when tracing symbols.",
    input: Schema.Union(
      Schema.Struct({ action: Schema.Literal("definitions", "references", "hover"), ...SymbolInput }),
      Schema.Struct({ action: Schema.Literal("diagnostics"), file: Schema.optional(Schema.String) })
    ),
    execute: (input, context) => {
      switch (input.action) {
        case "definitions": return codeDefinitions(cwd, input.file, input.symbol, input.line, input.column, context.signal)
        case "references": return semanticReferences(cwd, input.file, input.symbol, input.line, input.column, context.signal)
        case "hover": return languageHover(cwd, input.file, input.symbol, input.line, input.column, undefined, context.signal)
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
