import type {
  ProviderCatalog,
  ProviderConnectionId,
  ProviderId,
  ProviderModelId
} from "@jingler/core"
import { ProviderIcon, providerLabel } from "../components/provider-icon.js"
import { ChipMenu, type ChipGroup } from "../components/chip-menu.js"

export interface ProviderModelSelection {
  readonly connectionId: ProviderConnectionId
  readonly providerId: ProviderId
  readonly modelId: ProviderModelId
}

const selectionKey = (selection: Pick<ProviderModelSelection, "connectionId" | "modelId">): string =>
  `${encodeURIComponent(selection.connectionId)}:${encodeURIComponent(selection.modelId)}`

interface BrowsableModel extends ProviderModelSelection {
  readonly label: string
  readonly description: string
  readonly searchText: string
}

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
        return [{
          connectionId: connection.id,
          providerId: model.providerId,
          modelId: model.id,
          label: model.label,
          description: `${model.id} · ${connection.targetId}`,
          searchText: `${model.label} ${model.id} ${connection.targetId}`
        }]
      })
  )
}

export function ProviderModelBrowser({
  catalog,
  connectionId,
  modelId,
  onSelect,
  className
}: {
  catalog: ProviderCatalog
  connectionId: ProviderConnectionId | null
  modelId: ProviderModelId | null
  onSelect?: (selection: ProviderModelSelection) => void
  className?: string
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
  const groups: ReadonlyArray<ChipGroup<string>> = providerOrder.map(
    (providerId) => ({
      label: providerLabel(providerId),
      options: (byProvider.get(providerId) ?? []).map((model) => ({
        value: selectionKey(model),
        label: model.label,
        description: model.description,
        searchText: model.searchText
      }))
    })
  )
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
    <ChipMenu
      value={selected === undefined ? value : selectionKey(selected)}
      groups={groups}
      searchable
      searchPlaceholder="Search models…"
      emptyLabel="No models available"
      disabled={selections.length === 0}
      onSelect={(key) => {
        const selection = selections.find((candidate) => selectionKey(candidate) === key)
        if (selection !== undefined) {
          onSelect?.({
            connectionId: selection.connectionId,
            providerId: selection.providerId,
            modelId: selection.modelId
          })
        }
      }}
      icon={selected ? <ProviderIcon providerId={selected.providerId} size={14} /> : undefined}
      appearance="quiet"
      ariaLabel={`Model: ${selected?.label ?? modelId ?? "Choose model"}`}
      className={className}
    />
  )
}
