# Four-feature parity acceptance on current Main

All ten expanded parity cases pass on the current built Electron app (2026-10-07). Eleven additional real Electron terminal/archive, direct-checkout and background-task regressions pass on that unchanged build. The parent verified root gates and consumed the final independent source review; publication/checks are tracked separately.

## Electron coverage

All cases use `_electron` through `e2e/fixtures.ts`, real Settings/actions/RPC and persisted schema records. The Pi fixture scripts provider responses/tool requests; it does not implement filesystem mutations, lifecycle recovery, checkpoint admission or scheduler behavior. Assertions check filesystem bytes, Git staging, live HTTP responses and durable records in addition to visible controls.

Paths below are relative to `apps/desktop/e2e/` unless another directory is shown.

| Approved behavior | Actual acceptance case / precise regression |
| --- | --- |
| Workflow exact machine-local command approval and copied ignored file | `workspace-workflow.spec.ts`: approves setup, copied files, named Run/Stop, and archive cleanup. Checks setup bytes and copied `.env.local`. `packages/cli-adapters/src/projects.test.ts`: binds workflow consent to exact content and preserves it on re-registration. |
| Invalid Run draft rejected, removed live definition remains stoppable, named failure output | Same workflow case: invalid line rejected; changes definition while Dev runs; stops original Dev; real Fail exits 7 with visible output. |
| Setup failure blocks turn and Run | New workflow retry/skip cases: real setup exits 7 and writes one attempt; Run absent and no Run sentinel; attempted composer turn produces incomplete-setup diagnostic with no Pi completion. |
| Retry actually reruns setup and succeeds | New workflow retry case: allow marker then actual Retry; two attempt bytes, durable ready state, actual Run sentinel and admitted Pi turn. |
| Explicit Skip permits ordinary turns and Run | New workflow skip case: one setup attempt remains, durable setup-skipped, actual Run sentinel and admitted Pi turn. |
| Cleanup failure prevents archive; Retry recovers | New workflow retry case: first cleanup exits 7; still unarchived; actual failure-dialog Retry after an allow marker invokes cleanup again and archives. |
| Explicit acknowledged cleanup Skip recovers | New workflow skip case: first cleanup fails; actual `Archive without cleanup` action archives with only one cleanup attempt. |
| Restore does not replay setup or cleanup | Both new workflow cases restore through Archived sidebar; setup/cleanup attempt bytes remain fixed during bounded 1.5s observation. |
| Ordinary terminal descendants survive metadata archive/Restore and no cleanup runs | Existing `workspace-terminal-archive.spec.ts`: real PTY heartbeat stays live; cancel/acknowledge warning; preserved file/history and no cleanup sentinel. |
| Direct checkout archive/delete preserves checkout without worktree cleanup | `apps/desktop/src/main/metadata-only-archive.test.ts` and `direct-delete.test.ts` (service regressions; no added Electron claim). |
| Owned activity serializes lifecycle and retains descendants | `packages/cli-adapters/src/workspace-workflow.test.ts`: setup/skip/archive overlap; simultaneous Run starts; early-exiting leader descendants; cleanup closure ownership. |
| Durable unique primary ports; two actual previews; isolated Stop | Existing `workspace-ports.spec.ts`: two HTTP servers, distinct responses/URLs through Electron preview; Stop/archive one preserves other. |
| Approved URL readiness | Existing two-server case refuses Open preview before listener then verifies actual browser contents after start. New port case uses approved `{API_port}` template and verifies loaded URL. |
| Durable primary/extras environment across app restart | New port environment case: both real HTTP listeners return exact primary/API/workspace/root env; Stop, app close/relaunch, exact durable assignment and same actual env again. |
| Reassignment without killing unrelated owner, using actual UI | New port case: test-owned unrelated listener on old primary; Check ports warns; Reassign updates persisted port and visible label; new Run uses reassigned primary/API; unrelated server answers before and after new Stop. |
| Port validation / no credential or global environment injection | `packages/cli-adapters/src/workspace-ports.test.ts`: restricts templates/extra names; only workspace keys, never credential keys; listener probes. `runtime/tools/workspace-mutation-tools.test.ts`: allocated ports do not suppress unrelated eligible offload. |
| Opt-in checkpoint-safe creation; capture before actual production Pi edit | Existing `workspace-checkpoints.spec.ts`: fresh clean safe worktree, real Pi structured write and persisted Before-agent-turn snapshot. Creation disclosure now asserted. |
| Capture failure blocks with Retry; no silent bypass | Same checkpoint case: intent-to-add causes visible refusal, original bytes and no Pi completion; remove unsupported index entry and retry actual composer turn. |
| Active restore refused without stealing admission | Same checkpoint case: preview during scripted held production Pi turn gets Stop-all-work refusal; after turn settles only actual busy refusal is retried. |
| Exact workspace/index preview, staged/unstaged fidelity, secrets preserved | Same checkpoint case: separate staged/unstaged values, agent edit, post-capture index mutation, preview/confirm restore, ignored secret unchanged and absent from all captured file manifests. |
| Index-only preview cannot be mistaken for workspace diff | Same checkpoint case: workspace operations empty; staging operations/diff visible; confirm restores actual Git index. |
| Pinned recovery is usable | Added final section of same checkpoint case: selects actual latest pinned backup, checks index-only preview, confirms and verifies recovery index bytes plus unchanged worktree/secret. Partial-failure recovery additionally covered by checkpoint-store unit below. |
| Safe rename refuses source/destination mutation through actual production Pi tool path | New safe-refusals checkpoint case: scripted provider requests `workspace_rename`; real tool returns unsupported diagnostic; both existing file sentinels unchanged; diagnostic rendered and persisted in transcript. |
| Arbitrary shell refuses execution through actual production Pi tool path | Same new case requests `command_execute` with actual sentinel-write command; diagnostic rendered/persisted and shell sentinel unchanged. No fixture tool bypass. |
| Ordinary rename remains supported | `packages/cli-adapters/src/runtime/tools/workspace-mutation-tools.test.ts`: creates, edits, renames, deletes through registered tools; passed in this writer run. |
| Rename replacement races cannot delete other writers' files | Incoming `checkpoint-file-tools.test.ts`: safe rename refusal with replaced source/destination; preserved edits, passed in writer run. |
| Safe-mode scope excludes prior/unknown execution, native/remote/unsupported workspaces | `packages/cli-adapters/src/workspace-checkpoints.test.ts`: legacy/unsupported history, actual requested inactive native chat, ownerless tools, default OFF, tainted disable. `routine-validation.test.ts`: unsupported native/remote/Windows/setup. |
| Checkpoint path/index/HEAD/storage/retention protections | `workspace-checkpoint-store.test.ts`: intent-to-add refusal; immutable A-B-A index; verified HEAD/branch; unsafe permissions/bounds; corrupt backups; stale confirmation; hardlink isolation; oldest restore source at full retention; failed/latest successful pins across >20 restores. |
| Partial restore recovery | `workspace-checkpoint-store.test.ts`: recovers partially completed restore from pinned backup and leaves swapped symlink untouched. Electron addition covers successful restore's index recovery, not injected partial failure. |
| Shell/delegation/external tools and unsafe setup/cleanup blocked | `runtime/tools/tool-registry.test.ts`: denies before execution in safe mode; `workspace-workflow.test.ts`: safe shell setup/cleanup rejects before history taint. |
| Routine CRUD / explicit enable-disable / Save consent | Extended `workspace-routines.spec.ts` primary case: unapproved Save is invalid with no stored routine; explicit consent Save; edit schedule; disable while editing then Save remains disabled; Enable then Disable through buttons; Delete removes definition while retaining history. |
| Routine saved identity/model/reasoning/Ask, fresh isolated safe workspace | Primary routine case: actual production Pi inspect, run/session linkage, saved model/connection/endpoint equality, Ask mode, clean safe isolated worktree, untouched original checkout and Before-agent-turn capture. `routine-validation.test.ts`: exact settings and unsupported reasoning/model/credentials. |
| Routine manual + scheduled dispatch, global overlap skipped | Primary routine case: actual Run now and overlapping request with skipped record; scheduled once-through interval occurrence completes; linked workspace UI opens. `routine-store.test.ts`: missed occurrences/global overlap; `routine-scheduler.test.ts`: clock/startup grace. |
| Cancel, disable-save, durable history and no disabled dispatch after due/restart | Primary routine case: cancellation record; observes actual next due time while disabled; restart preserves run IDs and disabled flag. Added enable/disable/delete plus second restart demonstrates retained visible succeeded history after durable deletion. |
| Ask WRITE needs attention without escalation | Existing second routine case: real Pi write requested in Ask mode; needs-attention, unchanged checkout, no routine-proof in fresh workspace; saved model/connection/endpoint retained. |
| Auth loss gates unattended and manual dispatch | New signout routine case: enabled due occurrence, real Account menu Sign out before due; observes through due+1.5s with no runs or new workspaces; Run now surfaces auth/unavailable refusal and still no creation. `routines.test.ts`: authoritative null auth fences due callbacks; auth timeout no creation; suspended resume stays closed. |
| Startup no redispatch / durable association / bounded duration and teardown | `routine-scheduler.test.ts`: restart claimed occurrence; deferred cancellation; stopped/suspended claim; monotonic elapsed max-duration/backward wall clock; cancelled callback cannot abort next run. `routine-execution.test.ts`: checkpoint failure no prompt, late creation association, bounded mode mutation cancellation. `routine-shutdown.test.ts`: quit/drain behavior. |

## Final parent validation

| Gate | Result | Duration |
| --- | --- | --- |
| Fresh-built workflow and ports | 5/5 passed | 2.4 minutes |
| Same-build checkpoints and routines | 5/5 passed | 3.5 minutes |
| Same-build terminal metadata archive | 1/1 passed | 19.5 seconds |
| Same-build direct sessions and background tasks | 10/10 passed | 3.6 minutes |
| Root `pnpm test`, including all follow-on suites | 5,114 passed; 5 skipped | about 4.8 minutes |
| Root `pnpm lint` | zero errors; existing warnings reported | passed |
| Root `pnpm typecheck` | 21 successful tasks | 1m9.4s |
| Final independent source review `4ab22892` | OK; no issues found | no tests run by reviewer |

The parent fixed actual setup/cleanup recovery failures rather than bypassing them. Archive failure reload rejection stays actionable. Retry reacquires current history without granting terminal consent. Store-locked monotonic lifecycle timestamps and associated archive metadata fencing cover delayed replies, equal wall times and clock rollback. Plain workflow/archive diagnostic causes survive Electron's context bridge; the real cleanup-failure modal now displays and both Retry/Skip work through Restore without replay.

Earlier restricted writer socket failures were not accepted as test passes; socket-capable parent root tests and actual Electron cases supersede them. Electron source was unchanged between the fresh build and subsequent `SKIP_E2E_BUILD=1` batches. Logs and full adversarial resolutions: [adversarial-review-verdicts.md](adversarial-review-verdicts.md).

## Residual limits

The Pi provider responses are scripted; runtime tools, filesystem mutations, Git, RPC, HTTP previews, PTYs and scheduler behavior are real. No paid-provider, all-platform, hostile external-writer or exactly-once external-effect certification. Successful pinned recovery is covered in Electron; injected partial restore failure remains service coverage. Observation windows are bounded. Unsupported Windows shell ownership remains an explicit refusal regression, not Windows Electron certification. No security scanner is installed and no external QA check is configured. Remote checks are verified only after the final push. No merge or release authorized.
