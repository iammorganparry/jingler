# Claude enterprise CLI detection

- [x] Trace Claude CLI installation and subscription-auth detection end to end.
- [x] Confirm the root cause for Homebrew binaries and shell wrapper aliases.
- [x] Implement the smallest shared fix and regression tests.
- [x] Run targeted tests and review the final diff.

## Evidence

- macOS native CLI environments now retain the inherited PATH and append `/opt/homebrew/bin` and `/usr/local/bin` when absent.
- Endpoint detection, subscription verification, PI-backed Claude execution, and native Claude execution share that normalized PATH.
- Missing CLI errors are no longer mislabeled as subscription-auth failures.
- 40 targeted tests passed; 2 live tests skipped. CLI adapters typecheck passed. Biome found no new errors (2 pre-existing warnings).
- Independent review found no issues.
- Official auth guide: https://code.claude.com/docs/en/authentication
