export type ImportCardState =
  | { readonly kind: "detecting" }
  | { readonly kind: "found"; readonly count: number }
  | { readonly kind: "failed"; readonly message: string }

/** Home import card from the mcpImport machine's state; null = dismissed, idle, nothing found, or finished. */
export function deriveImportCard(input: {
  readonly machineState: string
  readonly count: number
  readonly error: string | null
}): ImportCardState | null {
  switch (input.machineState) {
    case "detecting":
      return { kind: "detecting" }
    case "detectFailed":
      return { kind: "failed", message: input.error ?? "Could not detect MCP servers" }
    case "reviewing":
    case "importing":
    case "importFailed":
      return { kind: "found", count: input.count }
    default:
      return null
  }
}
