# PR #338 — adversarial review verdicts

All 26 findings have been assessed. 25 have fixes; #6 remains blocked on the operator's safe-mode rename decision. This report does not claim full acceptance or merge readiness. Integrated full gates and fresh Electron rerun remain in progress.

| # | Verdict and resolution | Regression evidence |
|---|---|---|
| 1 | Real. Metadata-only unarchive requires archived state, bypasses destructive shutdown proof, preserves taint/lifecycle/jobs. Also covers legacy Windows unknown history. | metadata-only-archive.test.ts; workspace-terminal-archive.spec.ts |
| 2 | Real. Scoped acquireRelease makes capture/acquisition/finalizer registration interruption-safe before daemon ownership transfer. | workspace-checkpoints.test.ts deferred success/rejection interruption |
| 3 | Real. Unsupported workflow commands are refused before execution taint; disabling safe mode bypasses clean-history requirement only, retains exclusive admission and history. | workspace-workflow.test.ts; workspace-checkpoints.test.ts |
| 4 | Real. Preview exposes separate index operations/diff, includes staging in confirmation token. | workspace-checkpoint-store.test.ts staged add/overwrite/mode/deletion; checkpoint Electron visible index-only preview |
| 5 | Real for restore capacity, not total workspace usability. Persist successful/failed/pending restore outcomes; obsolete successful pins released; latest successful and unresolved/legacy pins retained. | 23 restores, reopen, failed-backup retention in workspace-checkpoint-store.test.ts |
| 6 | Real; BLOCKED. Initial link/unlink no-clobber fix fails independent review: replacement source/destination can be deleted. Operator asked to choose explicit unsupported safe rename or native atomic no-replace implementation. Do not count current draft as safe. | Independent review 0e94e687 exact interleaving; choice checkpoint-rename-safety pending |
| 7 | Real lifecycle gap; claim of no process groups overstated. Effect used groups but did not clean descendants after successful leader exit. Local POSIX shell now uses shared owned group registry, scoped awaited shutdown and retained admission. Unsupported Windows destructive ownership stays refused. | workspace-mutation-tools.test.ts actual redirected descendant and cancellation |
| 8 | Real. Named Run uses no execution timer; setup/cleanup retain bounded deadlines. | workspace-workflow.test.ts ten-minute timer boundary |
| 9 | Real for newly allocated worktrees, not all workspaces. Port allocation alone no longer suppresses offload classification; explicit port references stay local, offload eligibility still rejects server commands; safe-mode execution/priming stays excluded. | workspace-mutation-tools.test.ts; offload-session-primer.test.ts |
| 10 | Real. Reconciliation ignores current-process admission closures; only unowned running records become interrupted. | workspace-workflow.test.ts live setup listing/reconciliation |
| 11 | Real unattended admission gap, not failure of sign-out. Bounded authoritative AuthService validation before creation/prompt/resume/start, known expiry rejected, failure synchronously fences admission and clears authenticated state. No instantaneous revocation claim. | routine-auth.test.ts; actual RoutinesService routines.test.ts null/expiry/timeout/due callback/resume |
| 12 | Real. Revision-keyed form remount discards stale enabled checkbox after Disable. | workspace-routines.spec.ts disable then Save remains disabled |
| 13 | Real. Callback replacement preserves literal dollar syntax. | checkpoint-file-tools.test.ts $&, $$, $`, $' single/all |
| 14 | Real. Anchored stat returns absence for missing ancestor ENOENT only; unsafe ancestors still refused. | checkpoint-file-tools.test.ts nested write and symlink sentinel |
| 15 | Real. Shared anchored stat absence fix permits approved copy parent creation without following unsafe ancestors. | workspace-workflow.test.ts nested ignored copy integration |
| 16 | Real. Missing tracked directories verify as absent consistently. | workspace-checkpoint-store.test.ts directory deletion capture/restore |
| 17 | Real subprocess scaling; unmeasured latency claims rejected. Batch check-ignore, cat-file binary objects, and raw hash-object private immutable copies; preserve filters/index/modes/bounds. | 24 Git subprocesses for both 10 and 40 files (556ms/811ms host run), binary/newline paths and malformed batch regressions |
| 18 | Real. Per-routine revision fences replace global edit invalidation; validation failure no longer invalidates unrelated preparation. | routine-scheduler.test.ts unrelated edits/current occurrence checks |
| 19 | Real. Typed pending preparation/rejected teardown replace arbitrary message regex. Normal timeout messages fail occurrence without poisoning scheduler. Rejected stop retains unknown ownership. | routine-scheduler.test.ts; routines.test.ts early rejection and timeout-then-rejection |
| 20 | Real. List returns durable history with scheduler health/recovery, UI retains workspace links. | routine-scheduler.test.ts health/history; routines settings source |
| 21 | Real. Suspended/unavailable manual request uses expected RoutineRequestError; no claim, no fatal persistence state, resume remains available. | routine-scheduler.test.ts suspension/rejected manual/resume |
| 22 | Real. Shared startup promise clears on success/failure, concurrent attempts coalesce and failed reconciliation can retry. | routine-auth.test.ts startup retry; routine-scheduler.test.ts reconciliation retry |
| 23 | Real. Nonempty malformed Run lines reject with line-specific error; none silently disappear. | project-workflow-settings.test.ts no Save call for malformed line |
| 24 | Real positional workflow-label issue; broader stale-completion race not established. Exact unchanged definitions retain IDs, new definitions get UUIDs; launched label and removed live runs keep Stop. | project-workflow-settings.test.ts reorder/removal; workspace-workflow.spec.ts live removed command |
| 25 | Real. Failed named run shows label, exit code and bounded output with retry control. | workspace-workflow.spec.ts intentional failure diagnostics |
| 26 | Real child-reference retention; no measured heap-leak claim. Map holds bounded run states only, not ChildProcess; delete explicitly forgets session state after verified shutdown. | workspace-workflow.test.ts forget/list and owned process shutdown |

## Host verification so far

- Integrated focused suite: 122 tests passed across 12 files (`/tmp/jingler-adversarial-integrated-focused.log`).
- Windows guard followups: 18 tests passed (`/tmp/jingler-review-windows-guards.log`).
- Final routine/metadata/settings followups: 10 tests passed; desktop typecheck passed.
- Final root lint passed: complexity gate 0 errors, 87 warnings; Biome warnings also reported. Final root typecheck passed all 21 tasks after fixing PR-created test typing issues; ephemeral build-only fixture credentials used. Logs: `/tmp/jingler-pr338-review-lint-final.log`, `/tmp/jingler-pr338-review-types-final.log`. Final full unit gate still pending.
- Earlier fresh-build checkpoint/routine run: routines 2 passed; checkpoint test hit duplicate text caused by the newly exposed staging section. Fixed with distinctly labeled lists, without weakening restore assertions.
- Integrated fresh-build Electron run was interrupted by a new operator request after direct deletion/checkpoint scenarios passed. SIGTERM is not counted as a suite pass; rerun pending.
- Independent review approves routine/Windows followups (f0a20b5e). Checkpoint batch parsing approved, but rename BLOCKED (0e94e687). Workflow review's Windows findings fixed with regression tests.

## Sources and unchanged limits

Git batching matched [cat-file](https://git-scm.com/docs/git-cat-file), [hash-object](https://git-scm.com/docs/git-hash-object), [check-ignore](https://git-scm.com/docs/git-check-ignore). Node/Effect process behavior was checked against installed source and official guides in automation-acceptance.md. Provider responses remain scripted in real Electron/Pi acceptance; no paid-provider, hostile external-writer or unsupported-platform certification. No security scanner available. No merge/release authorized.
