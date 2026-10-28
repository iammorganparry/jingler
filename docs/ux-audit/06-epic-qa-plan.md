# Epic QA plan — run Jingler end to end as a user

Starts when the last feature lane (#476 slice 2, #838 slice 2, #563 slice 2) merges.
Output: `docs/ux-audit/07-epic-qa-findings.md`. Each finding gets the issue it was
checked against, what was expected, what happened, repro steps, a screenshot path, and a severity.

## Setup
- [ ] Fresh worktree on `origin/epic/redesign`, `pnpm install`, `pnpm --filter @jingler/desktop build`
- [ ] Baseline: `pnpm lint`, `pnpm typecheck` (CI env placeholders), `pnpm test`, full `pnpm --filter @jingler/desktop e2e`. Record every failure (`chat.spec.ts:75` / #744 is known)
- [ ] Two scratch repos (`qa-api`, `qa-web`) with GitHub remotes, registered as Jingler projects, to test across repos
- [ ] Launch the dev app (`pnpm dev`) with a clean `~/jingler` profile and a separate real profile. Drive it with real `claude`/`codex` agents, not the scripted agent

## Real agent runs (the core of the QA)
- [ ] A: one agent builds a small feature in `qa-api` (new endpoint + test). Follow it live: transcript, tool rows, Changes updating per turn, turn filter, diff stats, file tree Changed filter
- [ ] B: an agent that spawns subagents in their own worktrees. Check the Changes agent scope (#560), the scope bar and isolation when viewing a child (#563), the session PR chip (#561), and stopping and following a child
- [ ] C: one session attached to both `qa-api` and `qa-web` (multi-checkout, #670). Each repo's changes show under its own checkout group and update live. Switching checkouts doesn't leak diffs
- [ ] D: open PRs from A and C. Check the PR view (#441 Conversation, #443 Files/Checks, #442 rail), stack Rebase/Restack/Merge stack (#432/#433), the PR filter in Changes (#427), merging, then archiving and worktree removal (#865)
- [ ] E: Issues: start a session from a GitHub issue and a Linear issue (#447/#448), Reopen, and linked PRs
- [ ] F: Home (#476) Needs-you cards from a real approval prompt, Allow on Home, import card, stale state
- [ ] G: Settings: Usage (#502), Voice (#838), MCP import (#420), sign-in optional (#472)
- [ ] H: Offline / quota / limited states (#419/#421), provisioning progress (#478), crash and recovery

## UX sweep (every view)
- [ ] Window widths 1440 / 1100 / 900 / 800: truncation, wrapping badges, rail collapse
- [ ] Keyboard only: ⌘K, Esc, arrows in tabs, focus rings
- [ ] Light/dark themes: no hardcoded colours, contrast
- [ ] Empty, loading and error states for every list
- [ ] Paper parity: screenshot vs board for each redesigned view

## Grounding
- [ ] For each closed epic issue: tick its acceptance criteria against what was actually seen (pass / partial / fail)
- [ ] Merge in the ~25 gaps already recorded in closing comments

## Fix phase
- [ ] Triage findings: P0 regressions, then broken acceptance criteria, then UX polish
- [ ] One lane per cluster (2 lanes), each with an e2e reproducing the finding first
- [ ] Re-run the full suite on the epic; re-walk the failed scenarios
