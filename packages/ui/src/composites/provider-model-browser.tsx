import type {
  ProviderCatalog,
  ProviderConnectionId,
  ProviderId,
  ProviderModelId
} from "@jingler/core"
import { ProviderIcon, providerLabel } from "../components/provider-icon.js"
import { Select, SelectContent, SelectItem, SelectSearch, SelectTrigger, type SelectPlacement } from "../components/beui/select.js"
import { cn } from "../lib/cn.js"

export interface ProviderModelSelection {
  readonly connectionId: ProviderConnectionId
  readonly providerId: ProviderId
  readonly modelId: ProviderModelId
}

const selectionKey = (selection: Pick<ProviderModelSelection, "connectionId" | "modelId">): string =>
  `${encodeURIComponent(selection.connectionId)}:${encodeURIComponent(selection.modelId)}`

interface BrowsableModel extends ProviderModelSelection {
  readonly label: string
  readonly searchText: string
  readonly contextWindow: number | null
}

const formatContextSize = (size: number | null): string =>
  size === null
    ? "—"
    : size >= 1_000_000
      ? `${Number((size / 1_000_000).toFixed(1))}m`
      : size >= 1_000
        ? `${Math.round(size / 1_000)}k`
        : String(size)

/**
 * Every selectable model, grouped by PROVIDER rather than by connection: the
 * operator thinks "a Claude model" or "a Codex model", not "which of my three
 * identical connections". Duplicate connections to the same provider collapse —
 * each model appears once, bound to the healthiest (authenticated, most
 * recently updated) connection that offers it.
 */
const browsableModels = (catalog: ProviderCatalog): ReadonlyArray<BrowsableModel> => {
  const ordered = [...catalog.connections].sort((a, b) => {
    const authenticated =
      Number(b.connection.status === "authenticated") -
      Number(a.connection.status === "authenticated")
    if (authenticated !== 0) return authenticated
    return b.connection.updatedAt.localeCompare(a.connection.updatedAt)
  })
  const seen = new Set<string>()
  return ordered.flatMap(({ connection, models }) =>
    models
      .filter(({ selectable }) => selectable)
      .flatMap((model): ReadonlyArray<BrowsableModel> => {
        const identity = `${model.providerId}:${model.id}`
        if (seen.has(identity)) return []
        seen.add(identity)
        return [
          {
            connectionId: connection.id,
            providerId: model.providerId,
            modelId: model.id,
            label: model.label,
            searchText: `${model.label} ${model.id} ${connection.targetId}`,
            contextWindow: model.capabilities.contextWindow
          }
        ]
      })
  )
}

export function ProviderModelBrowser({
  catalog,
  connectionId,
  modelId,
  onSelect,
  className,
  inlineContent = false,
  placement
}: {
  catalog: ProviderCatalog
  connectionId: ProviderConnectionId | null
  modelId: ProviderModelId | null
  onSelect?: (selection: ProviderModelSelection) => void
  className?: string
  inlineContent?: boolean
  placement?: SelectPlacement
}) {
  const selections = browsableModels(catalog)
  const providerOrder: ProviderId[] = []
  const byProvider = new Map<ProviderId, BrowsableModel[]>()
  for (const selection of selections) {
    const existing = byProvider.get(selection.providerId)
    if (existing === undefined) {
      providerOrder.push(selection.providerId)
      byProvider.set(selection.providerId, [selection])
    } else {
      existing.push(selection)
    }
  }
  const groups = providerOrder.map((providerId) => ({
    providerId,
    label: providerLabel(providerId),
    options: (byProvider.get(providerId) ?? []).map((model) => ({
      value: selectionKey(model),
      label: model.label,
      searchText: model.searchText,
      contextSize: formatContextSize(model.contextWindow)
    }))
  }))
  const value =
    connectionId === null || modelId === null
      ? ""
      : selectionKey({ connectionId, modelId })
  const selected =
    selections.find((selection) => selectionKey(selection) === value) ??
    // A selection pinned to a deduped-away duplicate connection still names
    // the same model; represent it by the surviving row.
    (modelId === null
      ? undefined
      : selections.find((selection) => selection.modelId === modelId))

  return (
    <Select
      value={selected === undefined ? value : selectionKey(selected)}
      disabled={selections.length === 0}
      placement={placement}
      onValueChange={(key) => {
        const selection = selections.find((candidate) => selectionKey(candidate) === key)
        if (selection)
          onSelect?.({
            connectionId: selection.connectionId,
            providerId: selection.providerId,
            modelId: selection.modelId
          })
      }}
      className={cn("min-w-0", className)}
    >
      <SelectTrigger
        ariaLabel={`Model: ${selected?.label ?? modelId ?? "Choose model"}`}
        className={cn("h-8 w-auto min-w-0 rounded-xl border-0 bg-transparent px-2 py-0 text-xs hover:bg-surface focus-visible:ring-2", inlineContent && "w-full")}
      >
        <span className="truncate text-muted-foreground">{selected?.label ?? modelId ?? "Choose model"}</span>
      </SelectTrigger>
      <SelectContent
        inline={inlineContent}
        className={cn("right-auto w-72 shadow-none", inlineContent && "mt-1 w-full")}
        search={<SelectSearch autoFocus aria-label="Search models" placeholder="Search models…" />}
      >
        {groups.map((group) => (
          <div key={group.label} role="group" aria-label={group.label} className="py-0.5">
            <div className="px-2.5 py-1.5 text-[0.68rem] font-medium uppercase tracking-[0.12em] text-muted-foreground">
              {group.label}
            </div>
            {group.options.map((option) => (
              <SelectItem
                key={option.value}
                value={option.value}
                textValue={`${option.label} ${option.searchText}`}
                className="py-2"
              >
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <span data-provider-logo className="grid size-5 shrink-0 place-items-center">
                    <ProviderIcon providerId={group.providerId} size={16} />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm text-text-bright">{option.label}</span>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{option.contextSize}</span>
                </span>
              </SelectItem>
            ))}
          </div>
        ))}
      </SelectContent>
    </Select>
  )
}
