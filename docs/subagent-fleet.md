# Subagent Fleet

Jingler ships `pi-subagents` with its managed Pi runtime and presents delegated work in the **Fleet** drawer immediately above the composer. The drawer is available for every selectable model that has passed Jingler's Pi certification; it does not depend on a separately installed Pi or extension.

## Using Fleet

- Expand or collapse **Fleet** without changing the conversation. Drag its upper divider to resize it.
- Select **Main** for the parent transcript and composer. Select a child for that child's full, read-only Pi session; Fleet remains visible so Main is always one click away.
- Read each child's hierarchy, task, model, status, current tool, token/time usage, attention request, and emitted artifacts.
- Steer a running child, queue a follow-up, interrupt or stop it, resume a paused child, or answer a supervisor request. Jingler waits for the extension's exact acknowledgement before presenting the result.
- Background children remain visible after the parent turn settles. Missing processes are reconciled to `unknown`, never left falsely running.

## Containment model

Each managed child profile receives a distinct unguessable capability token bound server-side to one parent Pi session, target, role, and mode. Agent identity is not accepted from tool-call input, so a read-only child cannot claim a mutable profile. Child tool calls return through Jingler's capability broker, which reuses the normal schema validation, permission policy, cancellation, output budgets, idempotency, and mutation receipts. Reviewer, oracle, and advisor profiles remain read-only. Only the explicit `fanout` profile may recursively delegate.

The child launcher receives only ephemeral credentials for the selected provider and the exact selected profile capability. It is invoked through Jingler's pinned Node/Electron executable rather than an ambient shebang, and forwards termination to the real Pi child with bounded forced cleanup. Agent profiles, extensions, and tools are allowlisted; ambient Pi resources are disabled. Child transcripts are opened only when their exact session file is contained by the parent-derived `pi-subagents` session root.

Desktop and paired-device distributions include the same pinned Pi CLI, `pi-subagents`, profiles, wrapper, assets, and dependency closure. Remote updates install a versioned managed-runtime archive and atomically switch `managed-runtime/current`.

## Lifecycle and recovery

The extension remains lifecycle authority. Parent turn completion removes only turn-local subscriptions: Jingler retains the Pi session, broker, credentials, controls, transcripts, and polling while any child remains active, then atomically removes both its resumable-path and internal-session aliases. A continued turn reuses that retained session.

Jingler projects versioned events into a typed run tree and periodically reconciles the extension's status RPC independently of the parent turn stream. The newest evidenced parent owns the projection; replay is partitioned to it, and per-node clocks/tombstones reject duplicate, stale, reordered, cyclic, foreign-session, and malformed mutations. Normalized compatibility agents and the independent adversarial reviewer are adapted into this same Fleet surface rather than restored as a second tab bar.

On restart, Jingler reports only state it can reconcile. A child without a provably live process is shown as `unknown`; controls fail factually rather than guessing or replaying a mutation.

Schedules, mission administration, sharing, watchdog administration, agent-profile CRUD, and doctor/guide surfaces are intentionally outside the initial interactive Fleet scope.
