import type {
  ProviderCatalog,
  ProviderConnectionId,
  ProviderId,
  ProviderModelId
} from "@jingler/core"
import { ProviderIcon } from "../components/provider-icon.js"
import { ChipMenu, type ChipGroup } from "../components/chip-menu.js"
import { providerAuthRouteLabel } from "../lib/provider-connection-labels.js"

export interface ProviderModelSelection {
  readonly connectionId: ProviderConnectionId
  readonly providerId: ProviderId
  readonly modelId: ProviderModelId
}

const selectionKey = (selection: Pick<ProviderModelSelection, "connectionId" | "modelId">): string =>
  `${encodeURIComponent(selection.connectionId)}:${encodeURIComponent(selection.modelId)}`

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
  const selections = catalog.connections.flatMap(({ connection, models }) =>
    models
      .filter(({ selectable }) => selectable)
      .map((model): ProviderModelSelection & { readonly label: string } => ({
        connectionId: connection.id,
        providerId: model.providerId,
        modelId: model.id,
        label: model.label
      }))
  )
  const groups: ReadonlyArray<ChipGroup<string>> = catalog.connections
    .map(({ connection, models }) => ({
      label: [
        providerAuthRouteLabel(connection.authKind),
        connection.account?.displayLabel ?? connection.account?.fingerprint
      ].filter(Boolean).join(" · "),
      options: models
        .filter(({ selectable }) => selectable)
        .map((model) => ({
          value: selectionKey({
            connectionId: connection.id,
            modelId: model.id
          }),
          label: model.label,
          description: `${model.id} · ${connection.targetId}`,
          searchText: `${model.label} ${model.id} ${connection.targetId}`
        }))
    }))
    .filter(({ options }) => options.length > 0)
  const value =
    connectionId === null || modelId === null
      ? ""
      : selectionKey({ connectionId, modelId })
  const selected = selections.find((selection) => selectionKey(selection) === value)

  return (
    <ChipMenu
      value={value}
      groups={groups}
      searchable
      searchPlaceholder="Search certified models…"
      emptyLabel="No certified models"
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
