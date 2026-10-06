# Provisional phase4 parent review queue

Writer7a514 is still sole application writer. These are READ-ONLY observations of mutable drafts, not accepted findings; verify immutable handoff before changing code.

- [ ] Auth.getSession currently starts scheduler for valid session, but does not stop an already authenticated scheduler if a later getSession returns null. Verify intended sign-in gating and regression.
- [ ] RoutineScheduler deadline uses wall clock Date.now plus rearmed next-due timer. A backwards wall-clock jump may extend max duration. Verify real cancellation deadline is monotonic/enforced; add clock-shift check if needed.
- [ ] routineExecution links created workspace only after post-create validation + initial setMode. Cancellation or capture failure after creation can leave terminal history record sessionId null even though reserved session was actually created. Verify history association across this case (no relaunch) and exact-identity refusal.
- [ ] Application before-quit awaits RoutinesService.stop without a global bound; create/setMode effects lack AbortSignal even though prompt stop has10s bound. Verify cancellation during pending creation/capture/validation cannot make desktop quit indefinitely; do not fabricate stopped ownership or delete a remaining worktree.

Existing good draft mechanisms observed: cursor preserved for unchanged schedule; history keeps active records while trimming completed500; reserved requestedSessionId and exact routineOccurrence association; project digest/model/auth connection revalidation; no shell/native/model fallback; save/enable/delete generations invalidate pending dispatch; prompt takes actualchat shared AgentRunner gate and stops on operator gates/questions.
