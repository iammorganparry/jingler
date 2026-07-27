import * as React from "react"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { GitBranch, Plug, Settings, SquareTerminal, TerminalSquare } from "lucide-react"
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut
} from "./command.js"
import { Button } from "./button.js"

/**
 * The raw atom, without the palette's item model on top — the surface a future
 * consumer (an inline filter, a picker inside a dialog) would compose against.
 *
 * `Inline` renders the Command box unwrapped so the rows can be styled without
 * fighting a modal; `Dialog` is the real thing.
 */
const meta = {
  title: "Atoms/Command",
  component: Command
} satisfies Meta<typeof Command>

export default meta
type Story = StoryObj<typeof meta>

const Rows = () => (
  <CommandList>
    <CommandEmpty>No matching commands</CommandEmpty>
    <CommandGroup heading="Sessions">
      <CommandItem value="refactor auth">
        <GitBranch size={14} className="shrink-0 text-dim" />
        <span className="truncate">refactor auth</span>
        <span className="truncate text-[12px] text-muted-foreground">
          starbase · feat/auth
        </span>
      </CommandItem>
      <CommandItem value="theme tokens">
        <GitBranch size={14} className="shrink-0 text-dim" />
        <span className="truncate">theme tokens</span>
        <span className="truncate text-[12px] text-muted-foreground">
          starbase · feat/theme
        </span>
      </CommandItem>
    </CommandGroup>
    <CommandSeparator />
    <CommandGroup heading="Actions">
      <CommandItem value="new session">
        <SquareTerminal size={14} className="shrink-0 text-dim" />
        <span>New Session</span>
        <CommandShortcut>⌘N</CommandShortcut>
      </CommandItem>
      <CommandItem value="toggle terminal">
        <TerminalSquare size={14} className="shrink-0 text-dim" />
        <span>Toggle Terminal</span>
        <CommandShortcut>⌃`</CommandShortcut>
      </CommandItem>
      <CommandItem value="open settings">
        <Settings size={14} className="shrink-0 text-dim" />
        <span>Open Settings</span>
      </CommandItem>
    </CommandGroup>
    <CommandGroup heading="GitHub Issues">
      <CommandItem value="github-issues.refresh">
        <Plug size={14} className="shrink-0 text-dim" />
        <span>Refresh issues</span>
      </CommandItem>
    </CommandGroup>
  </CommandList>
)

/** The box on its own — the fastest way to iterate on row and heading styling. */
export const Inline: Story = {
  render: () => (
    <div className="w-[600px] overflow-hidden rounded-xl border border-line bg-panel">
      <Command>
        <CommandInput placeholder="Jump to a session or run a command…" />
        <Rows />
      </Command>
    </div>
  )
}

/** Every row filtered out — the state that most often ships looking broken. */
export const Empty: Story = {
  render: () => (
    <div className="w-[600px] overflow-hidden rounded-xl border border-line bg-panel">
      <Command>
        <CommandInput
          placeholder="Jump to a session or run a command…"
          value="zzzzz"
          onValueChange={() => {}}
        />
        <Rows />
      </Command>
    </div>
  )
}

/** The modal, top-anchored so the input holds still while the list resizes. */
export const AsDialog: Story = {
  render: () => {
    const [open, setOpen] = React.useState(false)
    return (
      <div className="flex h-[420px] items-start justify-center pt-8">
        <Button onClick={() => setOpen(true)}>Open (⌘K)</Button>
        <CommandDialog open={open} onOpenChange={setOpen}>
          <CommandInput placeholder="Jump to a session or run a command…" />
          <Rows />
        </CommandDialog>
      </div>
    )
  }
}
