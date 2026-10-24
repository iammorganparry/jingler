# Plan-mode audit (read-only)

Items marked (unverified) were inferred from grep/partial reads, not fully traced.

## 1. Where the mode lives
- **Definition**: `packages/core/src/domain.ts:283-289` `PermissionMode = ask|accept-edits|auto|plan`. Used as optional field at domain.ts:395, 714, 2020, 2066, 2106. Default `domain.ts:338-339` -> "auto".
- **Second enum** `RuntimeMode` (adds `read-only`) and roles (incl. "plan") copy-pasted as string arrays: `cli-adapters/src/runtime/tools/tool-registry.ts:17-19`, `workspace-tools.ts:9,15`, `mcp-tools.ts:22,28`, `plugin-agent-tools.ts:10-11`, `agent/pi-jingler-tools.ts:32-33`, `core/src/runtime/agent-runtime.ts:22,35`. (`core/src/mcp-config.ts:125` "plan" is an unrelated reserved MCP name.)
- **Persistence**: `cli-adapters/src/sessions.ts:112-125` (`runtimeMode`/`persistedMode`; unknown string -> "ask"), written :256, `setMode` :1262-1276; seeded from `defaultMode` :732/:936/:1057; copied on fork/close :1159/:1213.
- **Transient plan**: `agent-runner.ts:343-357` keeps plan in in-memory `modes` Ref, NOT persisted; prior mode in in-memory `priorModes` (:255). `exec-mode.ts` (`modeToRestore`, `modeOnApproval`, fallback accept-edits).
- **RPC**: `packages/contracts/src/index.ts:1055-1062` `Agent.setMode`; `apps/desktop/src/renderer/rpc-client.ts:790`; `apps/desktop/src/main/rpc.ts:598-601`.
- **UI**: `packages/ui/src/app/conversation-view.tsx:135-136` (shift+tab `MODE_CYCLE` excludes plan), `composites/composer.tsx:109,853-870` (plan appended `kind:"plan"`, gated by `allowPlan`), `mode-switch.tsx`, `new-workspace-machine.ts:35,66,100`, `new-workspace-view.tsx:313`, `settings-view.tsx`, `plan-card.tsx`. State: `renderer/conversation-machine.ts:236,522,1637`; `use-conversation.ts:50,108`. E2E `apps/desktop/e2e/plan-mode.spec.ts`.

## 2. Enforcement per harness
| Harness | Mechanism | Strength |
|---|---|---|
| Pi | Plan rewritten to auto/conversation (`pi-session-factory.ts:281-284`, `shared-planning.ts:302`), so role-based read-only (`tool-registry.ts:160-166`) is dead for plan. Only gate: plannotator-ext `pi.on("tool_call")` (`plannotator-ext/index.ts:1065-1073`) allowing only .md/.mdx writes in cwd while phase=planning. Prompt uses role "plan" (`pi-session-factory.ts:306`). | Weak |
| Claude | `--permission-mode plan` (`claude-agent-runtime.ts:53-55`) | Native, strongest |
| Codex | No plan handling; `codex/runtime.ts:257-259` -> on-request + workspace-write (only `read-only` sandboxes) | None |
| Approvals | `approvals.ts:72-78` `verdict()`: plan -> always allow | None |

**Bypasses (Pi)**
- Bash explicitly unrestricted ("prompt-guided", `plannotator-ext/index.ts:11`): redirects, `rm`, `git commit`, `curl`, installs all run; no gate.
- Registry mutate tools / `managed-file-tools.ts` / plugin tools / code-intel edit run under effective auto; hook coverage of them unverified (likely none).
- MCP: `mcp_call` has no read/mutate classification; can mutate.
- Scratchpad is NOT the only writable file: `tool-scope.ts isPlanWritePathAllowed` allows ANY .md/.mdx in cwd (AGENTS.md/CLAUDE.md/README -> prompt-injection/persistence). Symlink handling looks sound.
- Subagents: `direct-native-subagent.ts:23-27` forces read-only child (good); other subagent paths (`NATIVE_SUBAGENT_TOOLS`, `pi-session-factory.ts:290`) get effective auto (unverified).
- Codex: nothing blocks writes.

## 3. Lifecycle
- `plannotator_update_plan` (live, no review, `index.ts:960-1040`) and `plannotator_submit_plan` (review gate, :813-900), both path-checked.
- State persisted by `PlanningSession` (`shared-planning.ts:195-215`: phase, path, content, reviewPending, selectedMode). `decidePlanReview` (~:295) errors "Plan review is not active; resume it first" if no in-memory session.
- Approval -> `PlannotatorStateChanged phase=executing`; renderer hard-codes `SET_MODE auto` (`conversation-machine.ts:1637`), ignoring `modeOnApproval` precedence (unverified whether server overrides).
- Restart/crash: plan mode never persisted, `priorModes` in memory -> chat comes back in exec mode while plannotator state may still be planning/reviewPending; prior "auto" lost -> accept-edits fallback. `bind()` only resets to planning if incoming spec is plan.
- Legacy "plan" in stored data still accepted (`sessions.ts:117`).

## 4. Findings
**P0**
1. Pi plan is not read-only (bash, registry, MCP, plugin tools unrestricted under rewritten auto).
2. Codex has zero plan enforcement.

**P1**
3. Plan write allowlist = any .md in cwd (can edit AGENTS.md/CLAUDE.md).
4. Restart desync + silent downgrade of prior mode.
5. Client hard-codes auto on approval, ignoring `modeOnApproval`.
6. 6+ duplicated mode/role arrays can drift.
7. `verdict()` treats plan as auto; no approval path for risky actions in plan.

**P2**
8. Shift+Tab excludes plan; `allowPlan` makes availability inconsistent.
9. Plan conflates two axes (capability vs confirmation level); exit is lossy.
10. `persistedMode` coerces unknown strings to "ask".
11. role "plan" / mode "plan" / phase "planning" overlap.

## 5. Migration sketch
Target: `WorkMode = plan|build` x `ApprovalLevel = ask|accept-edits|auto` x `autoSwitch`.

| Piece | Change | Effort |
|---|---|---|
| Domain | Add `ApprovalLevel`, `WorkMode`, chat `workMode`/`autoSwitch`; drop "plan" from `PermissionMode` | 0.5d |
| Persistence | `persistedMode`: "plan" -> {approval = config default/accept-edits, workMode plan}; persist workMode (fixes restart desync, deletes `priorModes`/`exec-mode.ts` restore) | 1d |
| Contracts | Keep `Agent.setMode` (approval); add `Agent.setWorkMode {sessionId, chatId, workMode, autoSwitch}` + event for agent-driven switch | 0.5d |
| Runtime enforcement | Biggest. Decouple workMode from RuntimeMode/role; plan = capability filter (read + one scratchpad path) applied after approval; remove `effectiveRuntimeSpec` rewrite; deny/allowlist bash, classify MCP/plugin/subagent tools; scratchpad-only writes. Codex: read-only sandbox + approvalPolicy never. Claude: plan native, build maps from approval | 3-5d |
| Auto-switch | Tool `jingler_set_work_mode({mode, reason})`, registered only when autoSwitch, visible tool-call card; build may require plan approval unless approval=auto; per-turn rate limit | 1.5d |
| Approvals | Drop plan branch in `verdict()` | 0.25d |
| Plannotator | Approval sets workMode=build server-side (replaces `conversation-machine.ts:1637`); startup reconciles phase vs workMode | 1d |
| UI | Plan/Build toggle + approval dropdown + Auto; remove plan from `MODE_OPTIONS`, `MODE_CYCLE_WITH_PLAN`, mode-switch, new-workspace, settings; shift+tab cycles approval; `isExecutionMode` -> workMode | 2d |
| Tests | Update approvals/exec-mode/sessions/agent-runner/shared-planning/tool-registry/pi-session-factory/conversation-view/session-pane tests + e2e plan-mode; add enforcement matrix (each harness x bash write, rm, git commit, curl, MCP mutate, subagent write, non-plan .md) and migration fixture | 2-3d |

Total ~10-14 dev-days; enforcement + test matrix dominate. Fix P0 enforcement first; it pays off independent of the model split.
