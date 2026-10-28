import * as DropdownMenu from "@radix-ui/react-dropdown-menu"
import { ChevronDown } from "lucide-react"
import { Button } from "../components/button.js"
import type { SessionPrRow } from "../lib/session-prs.js"

export interface SessionPrsChipProps {
  /** Every PR open under this session: main first, then each subagent with one. */
  readonly rows: ReadonlyArray<SessionPrRow>
  /** A row was chosen; opens that PR's view in the content area. */
  readonly onSelect: (row: SessionPrRow) => void
}

/**
 * Header chip for a session's PRs once more than one is open — main plus any
 * subagent that has opened or linked its own. Renders `PRs · N ▾`; the popover
 * lists each PR's number, owning agent, branch (mono) and state word. A single
 * PR renders no chip here — `HeaderLinkChips` already covers that case with a
 * plain `PR #N` link, so this component only mounts once a child earns a row.
 */
export function SessionPrsChip({ rows, onSelect }: SessionPrsChipProps) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button
          variant="ghost"
          size="sm"
          data-testid="session-prs-chip"
          aria-label={`${rows.length} pull requests, open list`}
          className="h-7 flex-none gap-1 px-2 text-[11px]"
        >
          PRs · {rows.length}
          <ChevronDown className="size-3 flex-none text-dim" aria-hidden />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          data-testid="session-prs-chip-popover"
          className="z-50 flex w-[300px] flex-col gap-0.5 rounded-lg border border-line bg-sunken p-1.5 shadow-2xl"
        >
          {rows.map((row) => (
            <DropdownMenu.Item
              key={row.number}
              data-testid={`session-prs-chip-row-${row.number}`}
              onSelect={() => onSelect(row)}
              className="flex min-w-0 cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-[12.5px] outline-none data-[highlighted]:bg-surface data-[highlighted]:text-text-bright"
            >
              <span className="flex-none font-mono text-dim">
                {row.repo !== undefined && `${row.repo} `}#{row.number}
              </span>
              <span className="flex-none font-medium text-text-bright">{row.agent}</span>
              {row.branch !== null && (
                <span className="min-w-0 flex-1 truncate font-mono text-dim">{row.branch}</span>
              )}
              {row.state !== undefined && <span className="flex-none text-dim">{row.state}</span>}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
