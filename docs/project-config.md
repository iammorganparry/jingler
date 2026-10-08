# Shared project configuration

Humans and coding agents can commit `.jingler/project.json` in a project repository.
It contains portable commands and routine templates, never machine-local identity,
credentials or consent. Jingler does not discover, execute or save it automatically.
No active configuration is added to this repository; [the example](project-config.example.json)
is documentation only.

In Settings → Projects, select a registered local project and click **Load
.jingler/project.json**. A supplied workflow replaces the command review draft and
revokes its approval, including when the content is unchanged. If `workflow` is
absent, the existing command draft is retained. Saved commands remain unchanged
until **Save workflow**; saving without approval is allowed and will not run commands.
Loading is supported on macOS and Linux only; Windows is explicitly unsupported.
Remote projects cannot load this file. Switching projects discards the old import,
including a pending read.

Loaded routine templates appear for that selected project. **Load template …**
opens a new routine draft, even when a saved routine was being edited. Template ids
are stable shared identifiers, never saved routine ids. Consent and Enable schedule
start false. **Save routine** requires explicit local approval; no scheduler is
armed by loading. The operator may enable a schedule and approve before saving.
Routines keep their existing Ask permissions and edit/inspect-only restrictions.

An optional `providerId` and `modelId` pair is a preference. Jingler maps it only if
exactly one selectable desktop model matches. Omitted, partial, unavailable or
ambiguous preferences require explicit selection in **Managed Pi model**. There
is no fallback, runtime selection, connection id, endpoint id or credential field.
The provider catalogue's model naming is unchanged.

## Version 1 format

The [JSON Schema](project-config.schema.json) gives every field and numeric/string
bound. The runtime source is `packages/core/src/project-config.ts`, reusing
`ProjectWorkflow` and `RoutineInput` schemas. Unknown properties are errors at
every depth, including inside run commands, schedules and reasoning.

- Root: required `version: 1`; optional `workflow` object and `routines` array.
- Workflow: optional string `setup`/`cleanup`; required `runs` and `copyFiles` arrays
  (empty arrays are valid). Runs have exactly string `id`, `label`, `command`;
  all three must contain non-whitespace text and ids must be unique. Copy paths
  must be nonempty, repository-relative, and contain no nulls, backslashes,
  drive prefixes, empty, `.`/`..`, or `.git` components (case insensitive).
- Template: required nonempty string `id`, `name` (1–120 characters), `prompt`
  (1–100000), `baseBranch` (1–256), `schedule`, `reasoning`, `maxDurationMs`;
  optional nonempty `providerId` and `modelId` (at least 3 characters). Template
  ids must be unique within the array.
- Schedule: `{ "kind": "once", "at": <epoch milliseconds> }` or
  `{ "kind": "interval", "at": <epoch milliseconds>, "everyMs": <milliseconds> }`.
  `at` is an integer from 0 through JavaScript's max safe integer; `everyMs` is
  an integer from 1000 through 31536000000. These are absolute epoch times,
  not cron expressions or local datetime strings. The editor displays local time.
  Past occurrences follow existing skip rules; review the date before enabling.
- Reasoning: `null` for provider default, or `{ "enabled": <boolean>, "effort":
  <optional string> }`. Effort is one of `minimal`, `low`, `medium`, `high`, `xhigh`,
  `max`. `maxDurationMs` is an integer from 1000 through 86400000.

JSON Schema describes structure and ranges; the decoder additionally enforces
unique ids, non-whitespace run fields and safe copy paths as described above.
Ports, approval digests, approval/enabled flags, project ids, connections,
endpoints, runtime/mode overrides and secrets are rejected rather than ignored.

The registered project root is canonicalized, allowing trusted root symlink aliases.
Only the fixed path under that root is read through the shared anchored filesystem worker. Files larger than
1 MiB, non-regular files and symlinked files/directories are rejected (even an
in-repository symlink). Reads are bounded even if the file grows during loading.
Errors do not include the file's contents. Treat commands as code and review them
before saving and approving them locally; a shared file cannot grant execution
consent on another machine.
