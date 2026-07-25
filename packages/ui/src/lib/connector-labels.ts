import type { ConnectorAuthType } from "@starbase/core"

/**
 * How each way of connecting is named to the operator.
 *
 * One copy because the Connector Center renders it from three places — the
 * grid card's chips, the detail sheet's chips, and the sheet's mode tabs — and
 * they have to agree. `Record<ConnectorAuthType, …>` makes a new auth type a
 * compile error here rather than a missing chip somewhere; what it cannot catch
 * is two copies of the map drifting apart in wording, which is why there is one.
 *
 * These are display strings, not the wire values: OpenConnector's own names
 * (`api_key`, `custom_credential`) are what cross the RPC boundary and appear in
 * `@starbase/core`.
 */
export const AUTH_LABEL: Record<ConnectorAuthType, string> = {
  oauth2: "OAuth",
  api_key: "API key",
  // "Credentials" rather than "Custom credential": from the operator's side this
  // is just the multi-field form (host, username, password), and the "custom"
  // in the wire name describes the catalog's extensibility, not their task.
  custom_credential: "Credentials",
  no_auth: "No auth"
}
