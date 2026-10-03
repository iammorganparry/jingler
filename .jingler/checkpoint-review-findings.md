# Checkpoint prototype review — required before shipping

Read-only review `4c92f781-8701-4347-a39b-e507557d9b12`. Partial code preserved in `af2242ff`; no tests run by reviewer. Verdict: BLOCK restore unchanged.

- [ ] **P1: hardlinks and ancestor symlink races.** `O_NOFOLLOW` protects only the final path; `O_TRUNC` changes every hardlink. Use safe atomic replacement through anchored directory traversal or explicitly fail closed. Test an external hardlink sentinel and an ancestor swapped to a symlink; neither external target may change.
- [ ] **P1: capture index inconsistency.** Initial manifest and later copied index tree can differ after A→B→A staging. Derive manifest/tree from the same copied index, then validate live state. Test an index swap around copying; either reject or capture one consistent state.
- [ ] **P1: intent-to-add loss.** Tree reconstruction loses index-only flags. Explicitly reject `git add -N` until supported, and test the rejection preserves original staging.
- [ ] **P1: host semantic branch activation.** A detached capture currently refuses restore after host activates a branch at identical HEAD. Recognize verified host activation without accepting unrelated branch/HEAD drift. Test expected activation succeeds and actual HEAD movement fails.
- [ ] **P1: storage ancestry.** Recursive mkdir/chmod follows storage parent symlinks. Validate ownership and ancestry before any write/chmod, with safe traversal. Test redirected storage is refused and its destination is unchanged.

Parent observations for later validation:
- Restoring permissions must not widen access to captured private files. File/manifest corruption and pinned backup retention need behavioral checks.
- Measured on Node24/Darwin: opening a directory descriptor, renaming its path, then reading a child via both `/dev/fd/<fd>/child` and `/proc/self/fd/<fd>/child` yields ENOENT. Do not assume Linux descriptor paths provide anchored traversal on macOS.
- A possible stdlib-only approach to research/test is a Node subprocess whose cwd is each selected directory, verified against an inherited O_DIRECTORY/O_NOFOLLOW descriptor before relative operations; cwd stays attached when its former path is renamed. Every descended directory must be selected/verified likewise. This is a proposal, not accepted safety evidence; check packaged Electron Node execution support and performance before choosing it.
- Check Git-invoked hooks/fsmonitor/filter execution during capture; a quiescence gate must not start uncontrolled repository-configured commands itself.

Do not treat quiescence or a happy-path test as proof against filesystem races.
