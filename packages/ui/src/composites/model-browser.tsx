import * as React from "react"
import type { CliKind, HarnessCapability } from "@jingler/core"
import {
  Content,
  Portal,
  Root,
  Trigger
} from "@radix-ui/react-dropdown-menu"
import { ArrowLeft, Check, ChevronRight, Search, Settings } from "lucide-react"
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
  const [search, setSearch] = React.useState("")
  const selectedCapability = capabilities.find((candidate) => candidate.cli === cli)
  const selectedModel =
    selectedCapability?.models.find((candidate) => candidate.id === model) ??
    selectedCapability?.models[0]
  const activeCapability = capabilities.find((candidate) => candidate.cli === provider)
  const models = (activeCapability?.models ?? []).filter((candidate) =>
    `${candidate.label} ${candidate.description ?? ""}`.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <Root open={open} onOpenChange={(next) => {
      setOpen(next)
      if (!next) {
        setProvider(null)
        setSearch("")
      }
    }}>
      <Trigger asChild>
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
          <ChevronRight size={12} className="rotate-90 text-dim" />
        </button>
      </Trigger>
      <Portal>
        <Content
          side="top"
          align="start"
          sideOffset={7}
          collisionPadding={8}
          className="z-50 w-[520px] max-w-[calc(100vw-24px)] overflow-hidden rounded-xl border border-line bg-sunken shadow-2xl"
        >
          {activeCapability === undefined ? (
            <div className="py-1.5">
              {capabilities.map((capability) => (
                <button
                  key={capability.cli}
                  type="button"
                  onClick={() => setProvider(capability.cli)}
                  className="flex w-full items-center gap-3 border-b border-hairline px-4 py-3 text-left outline-none last:border-0 hover:bg-surface focus-visible:bg-surface"
                >
                  <ProviderIcon cli={capability.cli} size={18} />
                  <span className="flex-1 text-[14px] font-medium text-text-bright">{capability.label}</span>
                  <span className="text-[12px] text-muted-foreground">{capability.models.length} models</span>
                  <ChevronRight size={15} className="text-dim" />
                </button>
              ))}
            </div>
          ) : (
            <div>
              <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
                <button
                  type="button"
                  aria-label="Back to providers"
                  onClick={() => { setProvider(null); setSearch("") }}
                  className="flex size-8 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-surface hover:text-text focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <ArrowLeft size={16} />
                </button>
                <ProviderIcon cli={activeCapability.cli} size={17} />
                <strong className="text-[14px] text-text-bright">{activeCapability.label}</strong>
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
              <label className="flex items-center gap-2 border-b border-line px-4 py-3">
                <Search size={16} className="text-muted-foreground" />
                <input
                  autoFocus
                  value={search}
                  onChange={(event) => setSearch(event.currentTarget.value)}
                  placeholder="Search models…"
                  className="min-w-0 flex-1 bg-transparent text-[13px] text-text outline-none placeholder:text-dim"
                />
              </label>
              <div className="max-h-[360px] overflow-y-auto py-1.5">
                {models.map((candidate) => (
                  <button
                    key={candidate.id}
                    type="button"
                    onClick={() => {
                      onSelect?.(activeCapability.cli, candidate.id)
                      setOpen(false)
                    }}
                    className="flex w-full items-start gap-3 px-4 py-2.5 text-left outline-none hover:bg-surface focus-visible:bg-surface"
                  >
                    <ProviderIcon cli={activeCapability.cli} size={15} className="mt-0.5" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-medium text-text-bright">{candidate.label}</span>
                      {candidate.description && (
                        <span className="block truncate text-[11px] text-muted-foreground">{candidate.description}</span>
                      )}
                    </span>
                    {activeCapability.cli === cli && candidate.id === model && (
                      <Check size={15} className="mt-0.5 text-blue" />
                    )}
                  </button>
                ))}
                {models.length === 0 && (
                  <p className="px-4 py-8 text-center text-[12px] text-muted-foreground">No models match.</p>
                )}
              </div>
            </div>
          )}
        </Content>
      </Portal>
    </Root>
  )
}
