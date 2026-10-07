# PR #338 — adversarial review verdicts

Assessment/fixes are in progress. A finding is not resolved until its implementation, regression evidence and integration check are recorded.

| # | Finding | Assigned pass | Status |
|---|---|---|---|
| 1 | Metadata-only terminal archive cannot restore | Workflow/lifecycle | Pending |
| 2 | Interrupted checkpoint capture leaks lease | Checkpoint/filesystem | Pending |
| 3 | Refused shell cleanup taints safe mode and prevents disable | Checkpoint + workflow | Pending |
| 4 | Restore preview omits index-only changes | Checkpoint/filesystem | Pending |
| 5 | Pinned backups exhaust retention | Checkpoint/filesystem | Pending |
| 6 | Rename races destination creation | Checkpoint/filesystem | Pending |
| 7 | Ordinary shell descendants escape ownership | Workflow/lifecycle | Pending |
| 8 | Named servers have ten-minute deadline | Workflow/lifecycle | Pending |
| 9 | Port allocation disables unrelated offload | Workflow/lifecycle | Pending |
| 10 | Session listing interrupts live lifecycle | Workflow/lifecycle | Pending |
| 11 | Scheduled dispatch lacks current desktop auth | Routine/auth | Pending |
| 12 | Stale edited form undoes Disable | Routine/auth | Pending |
| 13 | Literal edit replacement expands dollar syntax | Checkpoint/filesystem | Pending |
| 14 | Safe write fails below missing parents | Checkpoint/filesystem | Pending |
| 15 | Approved copy fails below missing parents | Shared stat fix + workflow validation | Pending |
| 16 | Capture fails for deleted tracked directory | Checkpoint/filesystem | Pending |
| 17 | Capture launches Git several times per file | Checkpoint/filesystem | Pending |
| 18 | Editing one routine invalidates another's preparation | Routine/auth | Pending |
| 19 | Arbitrary timeout message permanently halts schedules | Routine/auth | Pending |
| 20 | Scheduler error hides recovery history | Routine/auth | Pending |
| 21 | Suspended manual request poisons scheduler | Routine/auth | Pending |
| 22 | Failed startup leaves started flag latched | Routine/auth | Pending |
| 23 | Malformed Run line silently deletes command | Workflow/lifecycle | Pending |
| 24 | Positional IDs mislabel live commands and hide Stop | Workflow/lifecycle | Pending |
| 25 | Named command failure lacks diagnostics | Workflow/lifecycle | Pending |
| 26 | Completed runs retain child references/session logs | Workflow/lifecycle | Pending |

All fixes preserve the approved restrictions. Unsupported or unprovable ownership must not be relabeled safe. Claims of perfect behavior, transactional restore against external writers, live paid-provider certification, or arbitrary remote-shell ownership remain out of scope.
