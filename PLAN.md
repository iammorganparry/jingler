# MCP managed authentication

- [x] Extend MCP schemas/contracts with per-server branding, auth kind, auth-aware status, and inbound credential/reauth actions while keeping secrets out of renderer responses and `mcp.json`.
- [x] Add encrypted per-server API-key and OAuth credential persistence by reusing the existing device secret document; resolve credentials only in the main process.
- [x] Implement MCP OAuth for remote HTTP servers with the installed official SDK, browser PKCE callback handling, refresh, forced reauthorization, and auth-specific failure classification.
- [x] Update Settings and the composer MCP menu to list connections and provide add/auth/reauth actions with server branding and safe icon fallback.
- [x] Surface `needs-auth` MCP connections in chat using the existing recovery-card pattern, then add focused unit/UI/integration tests and run typecheck plus affected test suites.
