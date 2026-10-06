# Routine review227e5005 — BLOCK cd157198

Independent readonly immutable review, no tests/writes. Known archive stale-cache/e2e expectation bugs excluded (subsequently fixed ad80c71c).

- [ ] P1 Auth.getSession null leaves previous authenticated scheduler running. Stop on null; valid→null→due no launch check.
- [ ] P1 maxDuration uses adjustable wallDate.now; backwards change extends deadline. Independent elapsed timer, schedules keep wallclock; skew/cancel/finish tests.
- [ ] P1 preparation validate/create/setMode lack abort propagation; cancel/quit awaits forever before prompt ten-second teardown. Real cancellation-aware preparation + bounded shutdown, halt routine admission and report unresolved ownership, preserve worktrees/activity/claim; no fabricated success. Deferred prep regressions and production signal propagation.
- [ ] P2 created history link happens after post-create validation/capture. Verify reserved+routineOccurrence then link immediately; actual kept workspace remains linked after failure/cancel, wrong identity never linked, late creation after bounded cancellation not orphaned.

Parent host ad80 rerun: checkpoint PASS30.3s; Ask WRITE needs-attention PASS14.8s; warned ordinary terminal archive PASS13.7s. Readonly routine manual success/capture/inspection/overlap passed, remainingtest failed exactgetByLabel Schedule at editing; page rolecombobox Schedule present. Correct role selector before rerunning schedule/cancel/restart (not passed yet).

Parent rootlint FAILfour newfeature complexity: checkpoint #current34, #preview28, anchored workeroperate27, routinesSettings24; refactor actual logical helpers not threshold/disable. Sourceprotection and synchronous expectedchecks must remain.

Sole writer71fadd7a assigned these bounded fixes; parent application readonly until handoff. Finalfullgates and independentacceptance stillpending.
