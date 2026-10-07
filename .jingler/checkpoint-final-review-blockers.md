# Independent checkpoint review710a5172 — BLOCK d66c9e33

Review used immutable d66c9e33; no writes/tests. Parent Electron PASS acknowledged, not independently reproduced.

- [ ] P1: validateInspectionProgram in runtime/tools/workspace-tools.ts accepts Git abbreviated branch --edit-descript, allowing configured core.editor execution. Replace denylist with exact inspection command/option syntax allowlist; reject abbreviated and unknown options before process launch. Regression with configured editor sentinel + abbreviated option: no process launched/file created, normal supported inspection still works.
- [ ] P1: WorkspaceCheckpointStore.#save backup retention can evict the selected restore source; restore then reads deleted blob directory. Exclude selected checkpoint from backup eviction; refuse insufficient capacity without deleting source. Test full20 slots and restoring oldest after actual file edit; succeeds or source intact on capacity refusal.
- [ ] P2: #restoreFile checks expected bytes before further asynchronous work and final replacement. External later save can be overwritten without being in pinned backup. Add explicit stop external editors/watchers warning before confirmation and best-effort wording. Pass expected content into anchored replacement worker for validation immediately before replacement; do not claim this eliminates final external race.

Previously reviewed mechanisms present: inode-verified directory descent, hardlink-breaking replacement, single-copy index capture, add-N rejection, pinned recovery, requested-chat/native guards. Cross-directory structured rename explicitly refuses (known limit). Ordinary-terminal archive change is separately operator approved and assigned phase4 writer.

Parent will implement/re-test these AFTER sole phase4 writer7a514 hands off. Do not mutate app code concurrently. No shipping approval from happy paths; final review/gates still pending.
