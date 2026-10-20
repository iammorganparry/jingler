import { StatusRow } from "./status-row.js"

/**
 * Import-review row for a candidate with an unresolved `{env:VAR}` header or
 * environment placeholder: it imports successfully but needs that secret
 * value filled in (in Settings) before the server can connect.
 */
export function NeedsSecretsRow() {
  return <StatusRow>Needs a secret value · Add it in Settings after import</StatusRow>
}
