I've completed the comprehensive UX/UI research on the three AI coding agent desktop apps. Since the output path is external to my workspace, I'm returning the complete research brief below—the runtime will persist it to the configured output location.

---

# UX/UI Research: AI Coding Agent Desktop Apps

## Executive Summary

Three leading parallel-agent desktop apps demonstrate distinct architectural philosophies that each shape their UI:

- **Conductor** (Melty Labs): Native macOS app, tightly focused on git worktree isolation, city-named workspaces, minimal chrome. Core model: one workspace = one shippable unit.
- **T3 Code** (pingdotgg): Electron cross-platform, web + desktop, bring-your-own-subscription, maximizes agent orchestration visibility. Core model: sidebar project/thread tree, single unified composer, plan-mode workflow.
- **Codex Desktop** (OpenAI): Electron tri-layer (React renderer, Node.js main, Rust CLI backend), most feature-complete. Core model: three-pane layout, automations as first-class citizens, integrated browser + computer use.

All three treat git as the source of truth and emphasize workspace/branch isolation.

## I. Conductor (conductor.build)

**Three-panel layout**: Sidebar (workspace list with city names + branch/PR titles), center chat pane, optional right diff viewer (Cmd+Shift+D). Status indicators on workspace rows (working/blocked/done/idle, inferred colors). File attachments in composer. Agent selection (Claude Code, Codex, Cursor, OpenCode) persists per workspace. Diff viewer shows all changes, supports per-turn filtering, line-level comments sent back to agent. Revert via message hover (undo icon discards all changes after). Checks tab pre-merge checklist (git status, CI, PR metadata, comments, todos). Settings organized by Harnesses (auth), Environment (vars), Repository preferences. Keyboard: Cmd+N (new), Cmd+Shift+D (diff), Cmd+Shift+P (PR), Cmd+K (Passport/search).

**Confirmed vs Inferred**: Layout + sidebar confirmed [docs]. Status colors inferred (docs mention working/blocked/done/idle but not exact palette). Pencil icon for unsent drafts confirmed [changelog 0.73.0]. Diff features fully confirmed [diff-viewer docs].

---

## II. T3 Code (t3.codes)

**Two-level sidebar** (projects > threads). Thread states: working (blue), pending approval (amber), completed (green), terminal running (teal). Center chat with inline change summaries (file paths clickable, +/- counts). Composer: @ file mentions with autocomplete (icons + paths), image drag-and-drop (8 max, 10MB each, thumbnails above input), model picker (Codex/Claude/Cursor/Grok/OpenCode, mid-thread switching), runtime mode toggle (lock/unlock = approval required/full access), interaction mode (plan vs default). Diff panel: unified view, per-turn filter (review one message at a time), checkpoint revert (hover > undo icon). Slash commands: /model, /plan, /default. Cross-platform: Electron with window controls overlay (titleBarStyle: hidden + Tailwind wco variant on Windows/Linux for titlebar-aware padding). No explicit GitHub review comment integration.

**Confirmed vs Inferred**: Thread states + layout fully confirmed [web-interface guide]. @ mentions, image handling, model picker confirmed. Per-turn filter confirmed. Cross-platform titlebar confirmed [PR #1969].

---

## III. OpenAI Codex Desktop App

**Three-pane layout**: Sidebar (workspace/session list with repo + branch/PR), center chat (inline tool calls, file diffs, command output, reasoning blocks), right panel (visual review panel + browser + automations). Runtime modes (Local/Worktree/Cloud). Image attachments. Per-block accept/revert in right panel (checkmark/X for hunks/files). Integrated browser toggle. **Automations** first-class: scheduled tasks (RRULE), cron-like execution, stored in Node.js DB. Architecture: React 18 + Radix UI frontend, Node.js main process (better-sqlite3, node-pty, Sentry, IPC handler registry with 70 methods), Rust CLI backend (tree-sitter, starlark, rmcp/MCP, sqlx-sqlite, tokio, oauth2). Fetch proxy auth gateway (auto-attaches Authorization headers, handles token refresh, routes vscode:// protocol URLs). Settings: keyboard shortcuts, MCP config, Skills (discover/install/remove), environment setup. No explicit plan mode documented, but architecture suggests agents can propose before implementing.

**Confirmed vs Inferred**: Architecture fully documented [architecture blog]. Three-pane layout confirmed [flowo.design]. Per-block accept/revert confirmed. Browser integration confirmed. Automations confirmed. Plan mode inferred. Status indicators not explicitly documented.

---

## Comparison Matrix

| Feature | Conductor | T3 Code | Codex |
|---------|-----------|---------|-------|
| **Platform** | macOS | Electron (Mac/Win/Linux) | Electron (Mac/Win) |
| **Open Source** | No | Yes (MIT) | No |
| **Sidebar Structure** | Workspace (city + branch/PR) | Project > Thread | Session/Workspace |
| **Status Indicators** | Color pulse (inferred) | Color + text label | Not documented |
| **Composer Controls** | Agent picker | Model picker, runtime mode, interaction mode | Runtime modes (Local/Worktree/Cloud) |
| **File Input** | Attachments | @ mentions + images | Image attachments |
| **Diff Review** | Unified, per-turn filter, comments | Inline + panel, per-turn, revert | Per-block accept/revert |
| **Parallel View** | Sidebar list | Thread list | Workspace list |
| **Automations** | None documented | None | First-class (RRULE scheduled) |
| **Browser Integration** | None | None | Integrated browser |
| **Keyboard Shortcuts** | Cmd+N/D/P/K documented | In-app reference | Settings page |

---

## Top 15 Concrete Patterns for Jingler

1. **City-Style Workspace Naming** ← Conductor — Memorable stable IDs (Cairo, Denver, Seoul) beat UUIDs; users recognize workspaces instantly.
2. **Unsent Draft Indicator** ← Conductor — Pencil icon on sidebar row prevents losing context in multi-workspace workflows.
3. **Project > Thread Two-Level Sidebar** ← T3 Code — Scales for teams managing multiple repos; flat list becomes unwieldy.
4. **Thread Status Color + Text Label** ← T3 Code — Redundancy for accessibility; color-blind users see state via text, sighted users scan visually.
5. **Model Picker in Composer** ← T3 Code — Switch models mid-thread without context loss; Codex → Claude for different task types.
6. **Runtime Mode Toggle (Lock/Unlock)** ← T3 Code — Tighten/loosen agent authority per conversation; one-click beats settings.
7. **Interaction Mode Selector (Plan vs Default)** ← T3 Code/Codex — Different paces for different tasks; toggle > search settings.
8. **@ File Mention Autocomplete** ← T3 Code — Faster than picker; feels like IDE intellisense; icons + paths in dropdown.
9. **Diff Per-Turn Filter** ← T3 Code — Reviewing 50 changes is overwhelming; 3-5 per turn catches regressions faster.
10. **Per-Block Accept/Revert** ← Codex — Right-side visual review with checkmark/X for hunks; faster than line comments for accept/reject.
11. **Checkpoint Revert** ← Conductor & T3 — Hover message > undo icon > confirm. Discards all changes after. One click undoes conversation branch.
12. **One-Click PR Creation** ← Conductor & T3 — Auto-generate title + body from branch/chat context. Eliminates GitHub context switch.
13. **Checks Tab Checklist** ← Conductor — Pre-merge readiness in one pane: git status, CI, PR approval, comments, todos. Prevents missing blockers.
14. **Archive & Restore Workspaces** ← Conductor — Archive completed work. History pane restores with full chat. Sidebar stays focused.
15. **Status Pulse Animation** ← Conductor — Blue (working) > Amber (blocked) > Green (done). Ambient info design; users spot urgency without reading.

---

## Gaps & Unknowns

1. **Global Command Palette**: Conductor has Cmd+K (Passport search), T3 Code has slash commands. No cross-app command palette coverage documented.
2. **MCP Status UI**: Conductor documents status dialog + refresh. T3 Code/Codex don't show how users see MCP server health.
3. **Multi-Agent Dashboard**: All three rely on sidebar list. No herd view or grid dashboard like Elyra (which has dashboard + tab strip + notifications).
4. **Terminal Integration**: Conductor & Codex mention terminal; T3 Code mentions toggle but not I/O UI details.
5. **Settings Hierarchy**: Conductor's Harnesses/Environment/Preferences model is clear. T3 Code/Codex sparse on provider config organization.
6. **Empty State Onboarding**: Only Conductor + Codex docs detail setup; T3 Code assumes existing providers.

---

## Sources

**Conductor**: conductor.build [landing, FAQ, review guide, diff-viewer, workflow, worktrees, changelog 0.73.0]
**T3 Code**: t3.codes [homepage], github.com/pingdotgg/t3code [README, PR #1969], mintlify wiki [web interface guide], docs/user/install.md
**Codex**: yuanjiwei.com [architecture blog], coding.flowo.design [desktop-app overview], github.com/openai/codex [issues #22290, #22952], developers.openai.com

---

**Output location**: `/Users/morganparry/jingler/pi-sessions/subagent-artifacts/outputs/59e7e288-6161-4851-8295-3acc73986a45/research.md`

**Research completed**: 2026-10-10  
**Methodology**: Web search (docs, blogs, GitHub issues/PRs), architecture analysis, pattern extraction, status confirmation via canonical sources.