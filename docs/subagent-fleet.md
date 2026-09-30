# Subagent tabs

Jingler ships `pi-subagents` with its managed Pi runtime and presents each delegated agent as a tab beside its parent chat. The tabs are available for every selectable model that has passed Jingler's Pi certification; they do not depend on a separately installed Pi or extension.

## Using subagent tabs

- A tab appears as soon as a real child agent starts. Workflow containers do not get tabs because they have no transcript of their own.
- Select a child tab for its full, read-only Pi session. Select the parent chat tab to return to the main transcript and composer.
- The selected child uses the normal composer for steering, replies, resume, and stop. Model, reasoning, mode, and environment remain parent-run choices.
- Read each child's complete effective prompt, model, status, current tool, token/time usage, attention request, final report, and emitted artifacts. Effective prompts—including runtime acceptance additions—are retained in progress, result, input, transcript, and metadata artifacts for operator audit.
- When a child finishes, its live tab closes automatically. Its transcript and final output remain available from the tab row's **Previous chats** menu.
- Background children remain visible after the parent turn settles. Missing processes are reconciled to `unknown`, never left falsely running.

## Native harness delegation

Native Claude, Codex, and OpenCode expose the same bounded `subagent` contract for foreground leaves and detached single, parallel, or chain work. Claude uses Jingler's bundled PI extension and its non-secret local CLI route marker; it does not require a configured PI provider connection. Codex and OpenCode run detached leaves through Jingler-owned `pi-subagents` external-job profiles backed by their existing authenticated CLIs. Settings keep role-to-model overrides per provider, and an unassigned role inherits that provider's parent model.

A session/chat-owned PI host remains alive after the native parent turn while detached work is active. It owns Fleet snapshots, transcripts, controls, capability credentials, and cleanup. A later turn in the same chat reuses that host with the new turn context; other chats, sessions, runtimes, and targets cannot address it.

Native controls report only what the underlying runtime can do:

| Control | Claude | Codex | OpenCode |
| --- | --- | --- | --- |
| Snapshot and transcript | Yes | Yes | Yes |
| Stop | Yes | Yes, including native stream cancellation | Yes, including native stream cancellation |
| Follow-up after completion | Yes | Yes | Yes |
| Live steer or reply | Only when the bundled PI child supports it | Explicitly rejected when the native job cannot apply it | Explicitly rejected when the native job cannot apply it |

Detached native job identity, terminal output, transcript material, and nullable usage are persisted without credentials. Restart recovery reopens the existing PI continuation and never redispatches a prompt. A native job that was queued or running but cannot be proven live becomes an `ambiguous-active-job` failure; repeated status and reattach calls return that same terminal result without recording usage twice.

## Agent launch contract

Self-implementation stays in the parent chat. An agent must not launch a workflow or a child named `main` as a proxy for work it is doing itself.

One delegated unit uses the structured single-child form:

```ts
subagent({ agent: "reviewer", task: "Review the current diff" })
```

That call creates one named child. The child owns the Pi transcript and control identity shown in its tab; there is no workflow container between the parent and child.

`workflowScript` is reserved for two or more named children with distinct bounded tasks:

```ts
subagent({
  workflowScript: `return runs.all([
    { key: "correctness", agent: "reviewer", task: "Review correctness" },
    { key: "tests", agent: "reviewer", task: "Review test coverage" }
  ])`
})
```

A workflow container represents orchestration and has no Pi transcript of its own. Its real children each receive a tab. Parallel implementation children need distinct scopes and isolated worktrees; otherwise keep one writer.

## Containment model

Each managed child profile receives a distinct unguessable capability token bound server-side to one parent Pi session, target, role, and mode. Agent identity is not accepted from tool-call input, so a read-only child cannot claim a mutable profile. Child tool calls return through Jingler's capability broker, which reuses the normal schema validation, permission policy, cancellation, output budgets, idempotency, and mutation receipts. Reviewer, oracle, and advisor profiles remain read-only. Only the explicit `fanout` profile may recursively delegate.

The child launcher receives only ephemeral credentials for the selected provider and the exact selected profile capability. It is invoked through Jingler's pinned Node/Electron executable rather than an ambient shebang; Electron enters Node mode before the wrapper starts in source, development, packaged desktop, and device runtimes. The wrapper forwards termination to the real Pi child with bounded forced cleanup. Agent profiles, extensions, and tools are allowlisted; ambient Pi resources are disabled. Child transcripts are opened only when their exact session file is contained by the parent-derived `pi-subagents` session root.

Desktop and paired-device distributions include the same pinned Pi CLI, `pi-subagents`, profiles, wrapper, assets, and dependency closure. Remote updates install a versioned managed-runtime archive and atomically switch `managed-runtime/current`.

## Lifecycle and recovery

The extension remains lifecycle authority. Parent turn completion removes only turn-local subscriptions: Jingler retains the Pi session, broker, credentials, controls, transcripts, and polling while any child remains active, then atomically removes both its resumable-path and internal-session aliases. A continued turn reuses that retained session. Supervisor delivery retains the last verified Pi session UUID, so an idle parent still receives a child request even after its transient UI context settles. Snapshot, transcript, and control lookup is additionally bound to the owning Jingler session and chat, preventing a valid parent identifier from crossing conversation boundaries.

Jingler projects versioned events into a typed run tree and periodically reconciles the extension's status RPC independently of the parent turn stream. The newest evidenced parent owns the projection; replay is partitioned to it, and per-node clocks/tombstones reject duplicate, stale, reordered, cyclic, foreign-session, and malformed mutations. Normalized compatibility agents and the independent adversarial reviewer are adapted into the same tab lifecycle.

On restart, Jingler reports only state it can reconcile. Native sidecar ownership is restored from a secret-free, owner-bound index; terminal native job records and transcripts are retained for 30 days. Active bundled PI work is reopened through its existing continuation and canonical `pi-subagents` artifacts. A child without a provably live process is shown as `unknown` or failed as ambiguous according to its runner contract; controls fail factually rather than guessing, restarting, or replaying a mutation.

Schedules, mission administration, sharing, watchdog administration, agent-profile CRUD, and doctor/guide surfaces remain outside the interactive subagent-tab scope.
