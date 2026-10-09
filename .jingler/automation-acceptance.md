# Workspace automation phases1–4 — completed local acceptance

Implementation commits through9e236590 on docs/conductor-feature-gap-research. No push, PR, release, tag, package version bump or Git object pruning. All four approved features are implemented; operator policies and bounded v1 limitations below remain explicit.

## Final gates

| Gate | Observable result | Evidence |
|---|---|---|
| pnpm lint | PASS;88warnings0errors, including configured complexity checks | /tmp/jingler-parent-root-lint-final-lease.log |
| pnpm typecheck | PASS21tasks; local build fixture environment required for server production build | /tmp/jingler-parent-root-types-final-lease.log |
| pnpm test | PASS503rootfiles,4790passed5skipped; relay/runtime follow-on suites50+53+25+135passed | /tmp/jingler-parent-root-tests-final-lease.log |
| Full desktop e2e coverage | All84files/291discoveredcases exercised serially in28bounded batches; gated live canaries remain skipped. All expected284unique source locations have successful/skipped evidence after fixes/reruns. | /tmp/jingler-e2e-full-batch-01.log through28.log; .jingler/e2e-full-batches.json |
| Final admission/feature regression | PASS16realElectron tests: background lifetime, actualPi direct deletion, failedcapture/Retry/restore, two liveportpreviews, desktoproutinemanual/scheduled/overlap/cancel/restart, AskWRITEattention/no escalation, warnedmetadataarchive and workflowcleanup | /tmp/jingler-e2e-final-admission-features.log |
| Independent source reviews | Review4d0cebc3 approves bounded checkpoint/routines5825726f. Reviewce672c0a approves daemon-admission/direct-delete/processgroup changes5bcb6c49 with source-only notes; parent separately verified real runtime/gates. | Session artifacts referenced by respective subagent runs; prior blocking findings resolved below |

Typecheck's Next production build refuses missing BETTER_AUTH_SECRET/CRON_SECRET/BETTER_AUTH_URL. Two independent ephemeral random32-byte build-only keys and https://build.example.invalid were supplied only in subprocess env; never printed/persisted, no production guards changed. This does not certify deployed credentials or connectivity.

Full e2e was split to respect the10-minute command bound, using the existing SKIP_E2E_BUILD reuse switch after an actual build. First batches testedab77bdc2. Direct-delete regression found inbatch8 was fixed5bcb6c49 and actualmainrebuilt; affected direct/daemon-background/feature scenarios reran againstfinalsource. A checkpoint preview raced finalizers; its test now retries ONLY the realbusy refusal, never bypasses admission or masks other errors. Final16tests allpass. No unrun/failed scenario is counted as a success. Credential/device-dependent canaries remain their repository-default skipped cases.

## Delivered behavior

1. Machine-local project command/file-copy approval, fresh isolated workspace setup/readiness/Retry/Skip, namedRun/Stop, owned process-group cleanup and archive lifecycle. Direct archive/delete preserves checkout and never invokes worktree cleanup.
2. Durable per-workspace ports and trusted environment propagation, extra-port raw drafts validated onSave, approvedHTTP(S) preview readiness and explicit reassignment. Two real servers remainisolated; no globalenv mutation/no kill unrelatedportowner.
3. Opt-in managedPi checkpoint-safe mode, initiallyOFF. Fresh clean/localPOSIX worktrees only; legacy/PTY/unsupported execution history cannot be treatedasclean. Capturebeforeactualrequestedchat turns; failedcapture blocks withRetry, no bypass. SeparateHEAD/index/worktree storage, exactpreviewtoken, protectedrestore-source retention, pinnedrecovery, hardlink/ancestor protections, near-replacement SHA/mode/absence checks. Structuredcross-directoryrename explicitly unsupported.
4. Desktop-only once/fixedinterval routines with explicitPi/model/connection/reasoning/Ask settings and consent; CRUD/enable/disable/manualRun/history/link/cancel. Fresh safe worktree viaactualcreation+modecapture+sharedAgentRunner gate. Oneactive routineglobally; no missedcatchup/overlap/daemon/cloud/webhooks. Durableclaimedrequestedidentity and exact association; no redispatch/exactly-onceexternal-effect claim. Authloss stops scheduling; elapsedmaxduration; boundedcancel/quit retainunresolvedmutationownership and haltadmission.

## Review blockers resolved

- Exact inspection options reject Git abbreviation/editor/external-output execution routes beforelaunch.
- Mandatorypre-restorebackup cannot evict selectedsource. Full20slotrealGit regression succeeds/protectssource.
- Restore validatesexpectedcurrent bytes/permissions/absence insideanchoredworker aftertempfsync immediatelybeforewrite/unlink; preservesoutsidehardlink sentinel and rejectslatechanges. External editor/watchers muststop; final kernelrace remains explicitlybest-effort, notclaimedlocked ortransactional.
- Nullauth, wallclockduration, deferredprep cancellation/quit, latecreatedfailedrunassociation and teardownownership nowtested.
- DarwintransientEPERM duringgroupzombiereaping is retried insideMONOTONICdeadline, neverconsideredgone; ONLYESRCH provesgroupdeath, persistentrefusal retainsownership. Concurrentstops shareonepoller/notification.
- Actual daemon ownsadmission throughfinalizers/backgroundlifetime, notlingeringRPCconsumer. Completed directsession deletion preservesHEAD/index/refs/worktree list/stagedunstaged/untrackedbytes.

## Explicit limits

Checkpoint-safe sessions/routines edit+inspect ONLY: arbitraryshell/build/test/PTY/delegation/offload/native/externaltools unsupported; Ask mutationrequiresoperatorattention, neverescalates. Unprovableterminalhistory allows ONLY acknowledgedmetadataarchive preservingjobs/files; destructivecleanup/delete remainsrefused. NoWindows/remote/direct checkpoint fallback. External concurrent edits cannot be locked. Timers are event-loop callbacks, nothard-real-time guarantees.

Semgrep/trivy/gitleaks unavailable; no automatedscanner pass claimed. Behavioral security regressions and independent source review supplied; no certification of hostile same-UID external processes or live paid-provider credentials.

## Official guides and installed versions

Node24.19.0 (Electron43.1.0 embedsNode24.18.0), Effect3.21.4, platform.96.2, XState5.32.4, Pi.84.1, pi-subagents.65.0, Git2.39.3. Source/signature checks and official docs linked in preflight and integration reports.

- [Node24 filesystem](https://nodejs.org/docs/latest-v24.x/api/fs.html), [timers](https://nodejs.org/docs/latest-v24.x/api/timers.html), [monotonic performance](https://nodejs.org/docs/latest-v24.x/api/perf_hooks.html).
- [Git option parsing](https://git-scm.com/docs/api-parse-options) and [branch2.39.3 source](https://raw.githubusercontent.com/git/git/v2.39.3/builtin/branch.c).
- [Effect v3 runtime](https://effect.website/docs/v3/runtime) and [resource finalization](https://effect.website/docs/v3/resource-management/introduction/).
- [XState actors](https://stately.ai/docs/actors), [Electron utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process), [before-quit](https://www.electronjs.org/docs/latest/api/app), [powerMonitor](https://www.electronjs.org/docs/latest/api/power-monitor).
- [Pi SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md), [models](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md), [OpenCode SDK](https://opencode.ai/docs/sdk/). Fixture substitutions fixed without productionmodel/credentialfallback changes.

Historical failed/paused native writers are superseded by preserved completedCLI implementations; no active subagent fleet/backgroundtestprocess remains. Do not resume superseded writers. Mission97e6ba17-f6d3-4d4b-803f-cbf002b9b607 can beclosed with this evidence; no release authorization implied.
