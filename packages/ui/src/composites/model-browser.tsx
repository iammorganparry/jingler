import * as React from "react"
import type { CliKind, HarnessCapability } from "@jingler/core"
import { ArrowLeft, Check, ChevronDown, ChevronRight, Settings } from "lucide-react"
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList
} from "../components/command.js"
import { Popover, PopoverContent, PopoverTrigger } from "../components/popover.js"
import { ProviderIcon } from "../components/provider-icon.js"
import { cn } from "../lib/cn.js"

export interface ModelBrowserProps {
  cli?: CliKind
  model?: string
  capabilities: ReadonlyArray<HarnessCapability>
  onSelect?: (cli: CliKind, model: string) => void
  onOpenSettings?: (cli: CliKind) => void
  className?: string
}

export function ModelBrowser({
  cli,
  model,
  capabilities,
  onSelect,
  onOpenSettings,
  className
}: ModelBrowserProps) {
  const [open, setOpen] = React.useState(false)
  const [provider, setProvider] = React.useState<CliKind | null>(null)
  const selectedCapability = capabilities.find((candidate) => candidate.cli === cli)
  const selectedModel = selectedCapability?.models.find((candidate) => candidate.id === model)
  const activeCapability = capabilities.find((candidate) => candidate.cli === provider)

  const close = () => {
    setOpen(false)
    setProvider(null)
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setProvider(null)
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Model: ${selectedModel?.label ?? model ?? "Choose model"}`}
          className={cn(
            "inline-flex min-h-8 max-w-[190px] items-center gap-1.5 rounded-md px-2 text-[11.5px] text-text outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-ring",
            className
          )}
        >
          {cli && <ProviderIcon cli={cli} size={14} />}
          <span className="truncate">{selectedModel?.label ?? model ?? "Choose model"}</span>
          <ChevronDown size={12} className="flex-none text-dim" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" sideOffset={7} className="w-[360px] overflow-hidden p-0">
        {activeCapability === undefined ? (
          <Command loop>
            <CommandInput placeholder="Search harnesses…" />
            <CommandList className="max-h-[300px]">
              <CommandEmpty>No harnesses available.</CommandEmpty>
              {capabilities.map((capability) => (
                <CommandItem
                  key={capability.cli}
                  value={capability.cli}
                  keywords={[capability.label]}
                  onSelect={() => setProvider(capability.cli)}
                  className="gap-2.5"
                >
                  <ProviderIcon cli={capability.cli} size={18} />
                  <span className="flex-1 font-medium text-text-bright">
                    {capability.label}
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    {capability.models.length} {capability.models.length === 1 ? "model" : "models"}
                  </span>
                  <ChevronRight size={15} className="text-dim" />
                </CommandItem>
              ))}
            </CommandList>
          </Command>
        ) : (
          <Command loop>
            <div className="flex items-center gap-2 px-2 pt-2">
              <button
                type="button"
                aria-label="Back to providers"
                onClick={() => setProvider(null)}
                className="flex size-8 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-surface hover:text-text focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ArrowLeft size={16} />
              </button>
              <ProviderIcon cli={activeCapability.cli} size={17} />
              <strong className="text-[13px] text-text-bright">{activeCapability.label}</strong>
              <span className="flex-1" />
              {onOpenSettings && (
                <button
                  type="button"
                  aria-label={`${activeCapability.label} settings`}
                  onClick={() => onOpenSettings(activeCapability.cli)}
                  className="flex size-8 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-surface hover:text-text focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Settings size={15} />
                </button>
              )}
            </div>
            <CommandInput autoFocus placeholder="Search models…" />
            <CommandList className="max-h-[300px]">
              <CommandEmpty>No models match.</CommandEmpty>
              {activeCapability.models.map((candidate) => (
                <CommandItem
                  key={candidate.id}
                  value={candidate.id}
                  keywords={[candidate.label, candidate.description ?? ""]}
                  onSelect={() => {
                    onSelect?.(activeCapability.cli, candidate.id)
                    close()
                  }}
                  className="items-start gap-2.5"
                >
                  <ProviderIcon cli={activeCapability.cli} size={15} className="mt-0.5" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-medium text-text-bright">
                      {candidate.label}
                    </span>
                    {candidate.description && (
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {candidate.description}
                      </span>
                    )}
                  </span>
                  {activeCapability.cli === cli && candidate.id === model && (
                    <Check size={15} className="mt-0.5 text-blue" />
                  )}
                </CommandItem>
              ))}
            </CommandList>
          </Command>
        )}
      </PopoverContent>
    </Popover>
  )
}
