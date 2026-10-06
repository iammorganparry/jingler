# Workspace automation — parent acceptance

Mission97e6ba17-f6d3-4d4b-803f-cbf002b9b607 remains active. No push/release. Approved scope and original design: conductor-implementation-plan.md.

- [x] Preserve integrated workflow/ports/checkpoint work locally (d66c9e33 latest WIP).
- [x] Parent production Electron checkpoint scenario passes; workflow/ports earlier scenarios pass.
- [x] Receive independent checkpoint review710a5172; acceptance BLOCKED on two P1s.
- [x] Receive sole writer7a514 handoff and preserve cd157198: routines/metadata archive implemented,123 focused tests reported. Parent host e2e exposed stale archive history and correct Ask write needs-attention vs wrong test expectation; not accepted.
- [x] Final-fix workflow76491b47 handed off ad80c71c: checkpoint retention/inspection/CAS and fresh archive load. Host checkpoint, Ask-write attention, warned archive PASS; readonly routine manual/capture/inspection/overlap passed but remaining schedule locator failed (not full scenario PASS).
- [ ] Sole writer a5f845cd continues preserved Native71f partial fixes (5edb26af). Native71f PAUSED after supervisor response tool was unavailable; no concurrent app writer. Close independent routines3P1/P2, full-root protocol/fixture regressions and lint. Parent application readonly until handoff.
- [ ] Fix exact Git inspection option allowlist, source-protected checkpoint eviction, near-replacement worker expectation checks and external-editor/watcher warning; add/run behavioral regressions.
- [ ] Independently review routines/launch/crash/cancel/shutdown integration; resolve findings.
- [ ] Run parent affected tests, loopback Pi factory tests, real Electron workflow/ports/checkpoints/routines/metadata archive scenarios.
- [ ] Run full pnpm lint, pnpm typecheck, pnpm test, desktop e2e; fix failures and rerun.
- [ ] Final independent safety acceptance, update evidence/approved limitations and complete mission only on actual green gates.

Security scanners semgrep/trivy/gitleaks unavailable; no scan success claimed. Preview/restore scopes remain isolated local POSIX worktrees. Safe mode defaults off, supports managed Pi edit/inspect only, no shell/terminal/delegation/offload. Routine one-time/fixed interval schedules are desktop-only, skip missed/overlap, one active routine globally. Unknown/unsupported execution history cannot enable checkpoint-safe mode. Destructive cleanup/delete remains refused on unprovable terminal history; acknowledged metadata-only archive preserves files and warns jobs may remain.
