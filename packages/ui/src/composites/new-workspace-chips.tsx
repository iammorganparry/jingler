import * as React from "react"
import { Check, ChevronDown, GitBranch } from "lucide-react"
import { Button } from "../components/button.js"
import { Checkbox } from "../components/checkbox.js"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "../components/command.js"
import { MorphPopover, MorphPopoverContent, MorphPopoverTrigger } from "../components/beui/popover-morph.js"
import { SegmentedControl } from "../components/segmented-control.js"
import type { NewSessionSource } from "./new-workspace-machine.js"

/** The single chip row under the New workspace prompt: `project ▾ · from main ▾ · worktree ▾`. */
export function ChipRow({ children }: { children: React.ReactNode }) {
  return <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5" data-testid="new-workspace-chip-row">{children}</div>
}

export interface FromSourceOption {
  value: NewSessionSource
  label: string
  description?: string
  icon: React.ReactNode
}

type FromTab = "branch" | "pr" | "issue"
const tabOf = (source: NewSessionSource): FromTab =>
  source === "pr" ? "pr" : source === "blank" || source === "branch" ? "branch" : "issue"

/**
 * `from <branch> ▾` chip. Its menu has Branch · Pull request · Issue tabs; the
 * PR / issue results render in the Start-from list below the prompt.
 */
export function FromChip({ label, source, branches, baseBranch, sourceOptions, disabled, onSource, onBranch }: {
  label: string
  source: NewSessionSource
  branches: ReadonlyArray<string>
  baseBranch: string
  sourceOptions: ReadonlyArray<FromSourceOption>
  disabled?: boolean
  onSource: (source: NewSessionSource) => void
  onBranch: (branch: string) => void
}) {
  const [open, setOpen] = React.useState(false)
  const issueOptions = sourceOptions.filter(({ value }) => tabOf(value) === "issue")
  const tab = tabOf(source)
  const tabs = [
    { value: "branch" as const, label: "Branch" },
    ...(sourceOptions.some(({ value }) => value === "pr") ? [{ value: "pr" as const, label: "Pull request" }] : []),
    ...(issueOptions.length > 0 ? [{ value: "issue" as const, label: "Issue" }] : []),
  ]
  const changeTab = (next: FromTab) => {
    if (next !== tab) onSource(next === "branch" ? "blank" : next === "pr" ? "pr" : issueOptions[0]!.value)
  }
  return (
    <MorphPopover open={open} onOpenChange={setOpen}>
      <MorphPopoverTrigger>
        <Button variant="outline" size="sm" aria-label="Start from" disabled={disabled} className="min-w-0 gap-1.5 px-2 font-mono text-[11px] font-normal">
          <GitBranch size={12} aria-hidden />
          <span className="min-w-0 truncate">{label}</span>
          <ChevronDown size={11} className="text-dim" aria-hidden />
        </Button>
      </MorphPopoverTrigger>
      <MorphPopoverContent side="top" align="start" className="w-[320px] overflow-hidden p-2">
        <SegmentedControl aria-label="Start from source" fullWidth size="sm" items={tabs} value={tab} onChange={changeTab} />
        {tab === "branch" && (
          <>
            <Command loop className="mt-2">
              <CommandInput placeholder="Search branches…" />
              <CommandList>
                <CommandEmpty>No branches match.</CommandEmpty>
                <CommandGroup>
                  {branches.map((branch) => (
                    <CommandItem key={branch} value={branch} onSelect={() => { onBranch(branch); setOpen(false) }}>
                      <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{branch}</span>
                      {branch === baseBranch && <Check size={13} className="flex-none text-blue" aria-hidden />}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
            <div className="mt-2 border-t border-hairline px-1 pt-2">
              <Checkbox label="Continue on this branch" checked={source === "branch"} onCheckedChange={(on) => onSource(on ? "branch" : "blank")} />
            </div>
          </>
        )}
        {tab === "pr" && <p className="px-2 py-3 text-[12px] text-muted-foreground">Pick a pull request from the Start from list below.</p>}
        {tab === "issue" && (
          <Command loop className="mt-2">
            <CommandList>
              <CommandGroup>
                {issueOptions.map((option) => (
                  <CommandItem key={option.value} value={option.value} onSelect={() => { onSource(option.value); setOpen(false) }}>
                    {option.icon}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{option.label}</span>
                      {option.description && <span className="block truncate text-[10.5px] text-muted-foreground">{option.description}</span>}
                    </span>
                    {option.value === source && <Check size={13} className="flex-none text-blue" aria-hidden />}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
            <p className="px-2 pb-1 pt-2 text-[11px] text-muted-foreground">Pick an issue from the Start from list below.</p>
          </Command>
        )}
      </MorphPopoverContent>
    </MorphPopover>
  )
}
