# PR #338 — final current-source acceptance

Date: 2026-10-07. PR is open for review, not draft. No merge/release requested.

## Current build

- **21 real Electron cases passed**, about 9.8 minutes across four bounded serial batches: expanded workflow/ports 5, checkpoints/routines 5, terminal metadata archive 1, direct sessions/background tasks 10.
- Workflow acceptance proves actual setup failure admission, Retry/Skip, named Run/Stop, visible cleanup failure, Retry/explicit cleanup Skip, durable Archive and Restore without hook replay.
- Ports prove primary/extras environment across restart, approved actual previews, reassignment preserving an unrelated listener, and isolated server ownership.
- Checkpoints prove real production Pi structured edits, capture failure admission, staging/worktree restore, secret preservation, pinned recovery and safe rename/shell refusal without sentinel mutation.
- Routines prove consent/CRUD, saved settings, actual scheduled/manual dispatch, Ask needs-attention, cancellation, disabled restart/no redispatch and sign-out gating.

The fresh build preceded the workflow/ports batch. Subsequent batches reused that unchanged production build. Test/document-only changes afterward do not alter the built app.

## Gates and source review

- `pnpm test`: **5,114 passed, 5 skipped** across root and follow-on suites (4,851 + 50 + 53 + 25 + 135); approximately 4.8 minutes.
- `pnpm lint`: zero errors; existing warnings reported (87 complexity warnings plus Biome warnings).
- `pnpm typecheck`: all 21 tasks successful. Build-only auth/cron secrets were generated only in a subprocess environment; invalid fixture URL, no persisted credentials or production bypass.
- `git diff --check`: passed.
- Independent source review `4ab22892`: **OK; no issues found**. This source review does not itself certify Electron/provider/platform behavior.

All 26 adversarial findings are addressed. The operator chose checkpoint-safe rename refusal rather than unsafe link/unlink or new native packaging. Ordinary rename remains supported. Acceptance also uncovered and fixed stale setup/archive snapshots, native Error failure delivery, and archive-dialog closing. Locked lifecycle timestamps increase under ties/rollback; metadata-only Restore preserves failed lifecycle content while advancing the version timestamp. Recovery-load rejection remains actionable without consent escalation.

## Historical coverage, not current-build certification

Earlier acceptance exercised all 84 desktop spec files / 291 discovered cases in serial batches and fixed observed regressions. Those results remain historical; the 21 cases above are the current-build rerun, not a claim that every desktop spec was rerun after these changes.

## Limits

Provider responses are scripted, while production Pi tool dispatch, Git/files/HTTP/PTYS/RPC/scheduling are real. No paid-provider, unsupported-platform, hostile concurrent-writer or exactly-once external-effect certification. Electron covers successful pinned recovery; injected partial restore failure remains service coverage. Security scanners semgrep/trivy/gitleaks are unavailable. No configured external QA check exists; do not report one as passed.

Final remote checks and reviews are verified after push, on the exact remote head. No merge or release authorized.

Details: [per-finding verdicts](adversarial-review-verdicts.md), [case matrix](parity-acceptance-matrix.md), [historical acceptance](automation-acceptance.md).
