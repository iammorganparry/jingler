# Plan Mode UX Audit: Competitor Analysis

## Summary
Four production coding agents (OpenCode, T3 Code, Conductor, Claude Code) implement plan mode as a read-only phase prior to edits. All use tool denial or permission enforcement to block mutations; agents enter plan via Tab toggle or `/plan` command (not auto-switching). Plan artifacts are markdown blocks or files. Approval flows range from simple "proceed" to multi-option refinement loops. Key gap: no observed "auto-switch Plan↔Build via visible tool call" model—all require explicit user intent or UI toggle.

## Findings

### 1. OpenCode (anomalyco/opencode v2)
**Mode model:** Two orthogonal primary agents (Build, Plan), not a single axis toggle.
- **Build:** default, full file/bash access
- **Plan:** read-only by default (file edits, bash both set to `ask`, effectively denied)

**Enforcement:** Tool denial via permission system. System prompt contains `CRITICAL: Plan mode ACTIVE - you are in READ-ONLY phase. STRICTLY FORBIDDEN: ANY file edits, modifications, or system changes.` Overrides all other instructions.

**Entry/exit:** User-initiated via Tab key toggle during session. Agent detects mode via system reminder.

**Plan artifact:** Markdown file in `.opencode/plans/*.md` directory. Agent writes plan there; user reviews in editor.

**Approval flow:** User reviews plan in editor, can request changes (`@general` subagent for multi-step research), or ask "Go ahead and make the changes." No formal approve/reject dialog.

**Post-approval:** Agent switches to Build mode (via Tab) and implements. Context persists; previous plan visible in history.

**Value:** Separates analysis from execution cleanly; permission model is explicit and auditable.

Sources: [OpenCode docs: Agents](https://github.com/sst/opencode/blob/dev/packages/web/src/content/docs/agents.mdx), [Plan mode system reminder](https://github.com/anomalyco/opencode/blob/ff4414bb152acfddb5c0eb073c38bedc1df4ae14/packages/opencode/src/session/prompt/plan.txt)

---

### 2. T3 Code (pingdotgg/t3code)
**Mode model:** Plan Mode is a collaboration mode (3-phase: ground, intent chat, implementation chat), not a separate agent. Recently deprecated as "legacy" behind `planModeEnabled` beta flag (default off as of Aug 2026).

**Enforcement:** Non-mutating vs. mutating action split. Plan mode allows reads, searches, dry-runs, builds (non-repo artifacts) but blocks file edits, formatters, patches, codegen. Enforced by instruction: "if the action would be described as 'doing the work' rather than 'planning the work,' do not do it."

**Entry/exit:** User-initiated via `/plan` command or explicit mode request. Not via keyboard toggle in current default UI. Agent stays in plan until user message "explicitly ends it."

**Plan artifact:** `<proposed_plan>` block in markdown (decision-complete format). Agent writes to `stdout` and user reviews inline.

**Approval flow:** 
- PHASE 1: Agent grounds self via exploration (non-mutating only).
- PHASE 2: Agent asks clarifying questions via `request_user_input` tool.
- PHASE 3: Agent refines spec until decision-complete.
- User responds with approval, feedback, or additional context.

**Post-approval:** Agent transitions to implementation. Plan context remains available.

**Value:** Structured question-asking (multiple-choice `request_user_input`, not free-form) reduces ambiguity before code. Decision-complete spec reduces implementer guesswork.

**Caveat:** Community feedback (PR #5551 comments) indicates deprecation as "legacy" is controversial—many users rely on plan mode. Plan mode is "a first class and supported feature by major harnesses."

Sources: [T3 Code plan mode developer instructions](https://github.com/pingdotgg/t3code/blob/78f462c4/apps/server/src/provider/CodexDeveloperInstructions.ts), [Plan mode removal PR #5551](https://github.com/pingdotgg/t3code/pull/5551), [Plan mode QoL issues #444, #770](https://github.com/pingdotgg/t3code/issues)

---

### 3. Conductor (conductor.build)
**Mode model:** Plan Mode is a session-level control (not a separate agent). Works with Claude Code, Codex, Cursor, or OpenCode running inside Conductor workspaces.

**Enforcement:** Conductor relays plan mode to underlying agent (e.g., Claude Code plan mode). Agent is responsible for blocking mutations.

**Entry/exit:** User toggles Plan Mode in UI (mode picker or command palette `/plan` command). Session-scoped; persists until user switches back to Build.

**Plan artifact:** Plan is displayed in Conductor UI or modal dialog. User can approve with feedback (v0.25.5+) or request changes.

**Approval flow:**
1. Agent proposes plan (exact format depends on underlying agent).
2. User can: approve (with optional feedback), request changes, or exit plan mode.
3. Feedback is fed back to agent for refinement.

**Post-approval:** Agent moves to implementation in same Conductor workspace. Diff Viewer shows changes incrementally.

**Value:** Workspace isolation (separate branch per issue/task) + plan approval creates safe experimentation. Feedback loop tightens refinement cycle.

Sources: [Conductor agent modes](https://www.conductor.build/docs/concepts/agent-modes), [Conductor changelog: approve plans with feedback](https://www.conductor.build/changelog/0.25.5-approve-plans-with-feedback-perf-improvements-gh-token-support)

---

### 4. Claude Code
**Mode model:** Permission modes (6 total): `default` (manual), `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions`. Plan mode is one rung on a ladder, not a separate agent.

**Enforcement:** Classifier reviews plan-mode actions; blocks file writes and risky bash. System prompt instructs agent not to use `ExitPlanMode` for research-only tasks—only for implementation planning.

**Entry/exit:** User-initiated via Shift+Tab toggle in CLI, mode selector in VS Code/Desktop, or `/plan` command. Can switch back with Shift+Tab.

**Plan artifact:** Plan file (written by agent to `.claude/plan.md` or similar location). User can open and edit via Ctrl+G before approving.

**Approval flow:**
1. Agent writes plan to file and calls `ExitPlanMode` tool.
2. User sees plan dialog with options: "Approve & switch to auto mode," "Approve & review each edit," "Keep planning."
3. User picks option or edits plan (Ctrl+G) then approves.

**Post-approval:** Agent switches to build mode and implements. If "review each edit," agent pauses for manual approval between file changes. If "auto," agent applies all edits without interruption.

**Value:** Editable plan (Ctrl+G) allows user to refine before execution. Explicit tool (`ExitPlanMode`) separates planning signal from casual messages. Multiple post-approval modes (auto vs. review-per-edit) give control granularity.

Sources: [Claude Code permission modes](https://code.claude.com/docs/en/permission-modes), [ExitPlanMode tool description](https://github.com/Piebald-AI/claude-code-system-prompts/blob/main/system-prompts/tool-description-exitplanmode.md), [Plan mode approval guide](https://orbtile.com/guides/claude-code-questions-and-plan-approval)

---

## Feature Comparison Table

| Feature | OpenCode | T3 Code | Conductor | Claude Code | Jingler (current) |
|---------|----------|---------|-----------|-------------|-------------------|
| **Mode type** | Agent toggle | Session mode | Session mode | Permission mode | ask/accept-edits/auto/plan |
| **UI toggle** | Tab key | `/plan` cmd (default off) | UI picker | Shift+Tab or `/plan` | UI radio (approval-mode list) |
| **Agent-initiated exit** | No | No | No | No | **Unknown** |
| **Plan artifact** | `.md` file | `<proposed_plan>` block | Dialog + modal | `.md` file (editable) | **Unknown** |
| **Approval tool** | None (text request) | `request_user_input` | UI dialog | `ExitPlanMode` (explicit) | **Unknown** |
| **Approval options** | Proceed / refine | Approve / refine / ask more | Approve / feedback / stay | Auto / review-per-edit / keep-planning | N/A |
| **Post-approval edits** | Auto (switched to Build) | Auto | Auto (in workspace) | Auto (unless review-per-edit) | Depends on mode |
| **Enforcement mechanism** | Tool denial (ask/deny) | Instruction split (mutating vs. non) | Delegation to underlying agent | Classifier review | **Unknown** |
| **Entry model** | User toggle | User explicit request | User toggle | User toggle | N/A |
| **Auto Plan↔Build switch** | No | No | No | No | **Researching** |

---

## Gaps & Unknowns

1. **Auto-switching Plan↔Build via visible tool call:** No production system observed implements this. All require explicit user intent (Tab, `/plan` command, or UI button). Jingler's consideration is novel.

2. **Jingler unknowns (marked above):**
   - Does Jingler's "plan" mode block tool calls (like OpenCode) or rely on prompt guidance?
   - What is the plan artifact (file, memory, checklist)?
   - What approval flow (simple "proceed" vs. multi-option)?
   - Can agent request to exit plan mode, or only user?

3. **Auto mode interaction with plan:** Claude Code and Conductor support plan + auto mode pairing; others do not. Interaction is underspecified in public docs.

4. **Plan artifact discoverability:** T3 Code's `<proposed_plan>` block is inline but easy to miss; Claude Code's `.md` file is persistent but requires manual `Ctrl+G` to edit. No standardized "plan review UI" across systems.

---

## Key Takeaways for Jingler

- **No precedent for agent-initiated Plan↔Build switching:** All competitors use user-driven toggles. If Jingler implements auto-switch via visible tool, it differentiates but may surprise users accustomed to explicit control.
- **Approval feedback loops matter:** T3 Code's structured `request_user_input` and Claude Code's editable plan (Ctrl+G) reduce refinement friction.
- **Plan as orthogonal to approval modes:** OpenCode's cleanest model—Plan/Build are agents, approval (ask/accept/auto) is separate. Jingler's current design mixes them (plan is in the approval-mode list).
- **Enforcement explicitness:** Tool denial (OpenCode, Claude Code) is clearer than instruction guidance (T3 Code) when blocking mutations.

---

**Report generated:** 2026-10-24  
**Sources:** OpenCode v2 docs & GitHub, T3 Code GitHub (PR #5551, issues), Conductor docs & changelog, Claude Code docs & system prompts, community feedback.
