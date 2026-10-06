# Workspace automation — parent acceptance

Mission97e6ba17-f6d3-4d4b-803f-cbf002b9b607 remains active. No push/release. Approved scope and original design: conductor-implementation-plan.md.

- [x] Preserve integrated workflow/ports/checkpoint work locally (d66c9e33 latest WIP).
- [x] Parent production Electron checkpoint scenario passes; workflow/ports earlier scenarios pass.
- [x] Receive independent checkpoint review710a5172; acceptance BLOCKED on two P1s.
- [x] Receive sole writer7a514 handoff and preserve cd157198: routines/metadata archive implemented,123 focused tests reported. Parent host e2e exposed stale archive history and correct Ask write needs-attention vs wrong test expectation; not accepted.
- [ ] Sole final-fix writer in workflow76491b47 implements checkpoint review corrections, fresh archive-session load and real read-only/needs-attention routine e2e. Concurrent independent review uses immutable cd157198. Parent does not edit application code concurrently.
- [ ] Fix exact Git inspection option allowlist, source-protected checkpoint eviction, near-replacement worker expectation checks and external-editor/watcher warning; add/run behavioral regressions.
- [ ] Independently review routines/launch/crash/cancel/shutdown integration; resolve findings.
- [ ] Run parent affected tests, loopback Pi factory tests, real Electron workflow/ports/checkpoints/routines/metadata archive scenarios.
- [ ] Run full pnpm lint, pnpm typecheck, pnpm test, desktop e2e; fix failures and rerun.
- [ ] Final independent safety acceptance, update evidence/approved limitations and complete mission only on actual green gates.

Security scanners semgrep/trivy/gitleaks unavailable; no scan success claimed. Preview/restore scopes remain isolated local POSIX worktrees. Safe mode defaults off, supports managed Pi edit/inspect only, no shell/terminal/delegation/offload. Routine one-time/fixed interval schedules are desktop-only, skip missed/overlap, one active routine globally. Unknown/unsupported execution history cannot enable checkpoint-safe mode. Destructive cleanup/delete remains refused on unprovable terminal history; acknowledged metadata-only archive preserves files and warns jobs may remain.
