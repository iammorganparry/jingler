# Claude authentication support

- [x] Trace API-key and subscription selection and consult current provider docs.
- [x] Fix gaps while preserving explicit billing selection: no production gap found; added four regression cases for both session routes, pinned credentials, and Claude API-key entry.
- [x] Run focused tests and security checks; report live-verification limits.

## Evidence

- 69 tests passed across nine focused suites; cli-adapters and UI typechecks passed.
- Installed pi-ai and pi-coding-agent: 0.84.1. Local Claude Code: 2.1.258.
- Current official auth reference: https://code.claude.com/docs/en/authentication
- Current CLI reference: https://code.claude.com/docs/en/cli-reference
- No live inference or credential verification performed. Tests use fake credentials/processes; they do not prove account entitlement or network availability.
- Semgrep, Trivy, and Gitleaks are unavailable. No production authentication code changed.
- Commands ran on Node 22.14.0; repository requests Node >=24.0.0. Tests and typechecks passed despite the engine warning.
