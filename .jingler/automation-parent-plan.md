# Workspace automation — parent acceptance

Mission97e6ba17-f6d3-4d4b-803f-cbf002b9b607 remains active. No push/release. Approved scope and original design: conductor-implementation-plan.md.

- [x] Preserve integrated workflow/ports/checkpoint work locally (d66c9e33 latest WIP).
- [x] Parent production Electron checkpoint scenario passes; workflow/ports earlier scenarios pass.
- [x] Receive independent checkpoint review710a5172; acceptance BLOCKED on two P1s.
- [ ] Await sole writer7a514 handoff: fully wired desktop routines, warned metadata-only terminal-history archive, and six terminal-fixture regressions. Parent does not edit application code concurrently.
- [ ] Fix exact Git inspection option allowlist, source-protected checkpoint eviction, near-replacement worker expectation checks and external-editor/watcher warning; add/run behavioral regressions.
- [ ] Independently review routines/launch/crash/cancel/shutdown integration; resolve findings.
- [ ] Run parent affected tests, loopback Pi factory tests, real Electron workflow/ports/checkpoints/routines/metadata archive scenarios.
- [ ] Run full pnpm lint, pnpm typecheck, pnpm test, desktop e2e; fix failures and rerun.
- [ ] Final independent safety acceptance, update evidence/approved limitations and complete mission only on actual green gates.

Security scanners semgrep/trivy/gitleaks unavailable; no scan success claimed. Preview/restore scopes remain isolated local POSIX worktrees. Safe mode defaults off, supports managed Pi edit/inspect only, no shell/terminal/delegation/offload. Routine one-time/fixed interval schedules are desktop-only, skip missed/overlap, one active routine globally. Unknown/unsupported execution history cannot enable checkpoint-safe mode. Destructive cleanup/delete remains refused on unprovable terminal history; acknowledged metadata-only archive preserves files and warns jobs may remain.
