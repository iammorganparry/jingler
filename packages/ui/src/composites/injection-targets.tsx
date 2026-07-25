import type { CliKind, McpInjectionSkip, McpInjectionTarget } from "@starbase/core"
import * as React from "react"
import { Badge } from "../components/badge.js"
import { Toggle } from "../components/toggle.js"

/**
 * "Which agents actually get these tools?" — answered by the resolver, per harness.
 *
 * Connecting a provider in the Connector Center is only half the promise; the other
 * half is that a `claude` / `codex` / `opencode` session really starts with the
 * unified server attached. Four independent things can silently break that (the
 * master switch, a per-harness opt-out, a missing token, a harness Starbase can't
 * launch) and from the settings screen alone they all look identical. Each row
 * therefore states the outcome AND the reason, sourced from
 * `OpenConnector.injection` — the same call path the agent runner takes.
 */
export interface InjectionTargetsProps {
  readonly targets: ReadonlyArray<McpInjectionTarget>
  readonly loading?: boolean
  /** Flip a harness's opt-out (writes `openConnector.perCli[cli]`). */
  readonly onToggle?: (cli: CliKind, enabled: boolean) => void
}

const LABEL: Record<CliKind, string> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  opencode: "opencode",
  starbase: "Starbase"
}

/** Operator-facing wording for each way injection can be off. */
const REASON: Record<McpInjectionSkip, string> = {
  disabled: "Turn on Enable above to inject the shared server.",
  "opted-out": "Switched off for this agent.",
  "no-token": "No API token stored — add one above.",
  "no-run-path": "Starbase does not launch this agent, so there is nothing to inject."
}

export function InjectionTargets({ targets, loading = false, onToggle }: InjectionTargetsProps) {
  return (
    <section className="flex flex-col gap-2" aria-label="Agents receiving the shared server">
      <div>
        <h4 className="text-[12.5px] font-semibold text-text-bright">Agents receiving these tools</h4>
        <p className="mt-0.5 text-[11px] text-dim">
          Every provider you connect reaches each agent below the next time it starts.
        </p>
      </div>

      <div className="flex flex-col divide-y divide-line rounded-lg border border-line">
        {loading && targets.length === 0 ? (
          <div className="px-3 py-2 text-[11px] text-dim">Checking agents…</div>
        ) : null}
        {targets.map((target) => (
          <InjectionRow key={target.cli} target={target} onToggle={onToggle} />
        ))}
      </div>
    </section>
  )
}

function InjectionRow({
  target,
  onToggle
}: {
  target: McpInjectionTarget
  onToggle?: (cli: CliKind, enabled: boolean) => void
}) {
  // A harness with no run path can't be toggled into receiving anything, so it
  // shows the fact rather than a control that would do nothing.
  const togglable = onToggle !== undefined && target.skipped !== "no-run-path"
  return (
    <div className="flex items-center gap-2.5 px-3 py-2" aria-label={LABEL[target.cli]}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-[12.5px] font-medium text-text-bright">{LABEL[target.cli]}</span>
          {target.injected ? (
            <Badge tone="green" size="xs">
              injected
            </Badge>
          ) : (
            <Badge tone="neutral" size="xs">
              not injected
            </Badge>
          )}
        </div>
        <div className="truncate font-mono text-[10px] text-dim">
          {target.injected
            ? `${target.serverName} · ${target.url ?? ""}`
            : (target.skipped ? REASON[target.skipped] : "")}
        </div>
      </div>
      {togglable ? (
        <Toggle
          checked={target.skipped !== "opted-out"}
          onCheckedChange={(next) => onToggle?.(target.cli, next)}
          aria-label={`Inject into ${LABEL[target.cli]}`}
        />
      ) : null}
    </div>
  )
}
