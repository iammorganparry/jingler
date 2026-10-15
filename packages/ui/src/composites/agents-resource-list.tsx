import type { ManagedResource, ManagedResourceOrigin, ManagedResourceSelector } from "@jingler/core"
import { Boxes, FolderOpen, Trash2 } from "lucide-react"
import { useCallback, useMemo } from "react"
import { Button } from "../components/button.js"
import { FilterChips, type FilterChipOption } from "../components/filter-chips.js"
import { SearchField } from "../components/search-input.js"
import { Toggle } from "../components/toggle.js"
import { VirtualList } from "../components/virtual-list.js"

/** "Agents" are the prompt-kind resources; "Skills" are the skill-kind ones. */
export type ResourceKindFilter = "all" | ManagedResource["kind"]
export type ResourceSourceFilter = "all" | ManagedResourceOrigin

export interface ResourceFilter {
  readonly query: string
  readonly kind: ResourceKindFilter
  readonly source: ResourceSourceFilter
}

const ROW_HEIGHT = 56
const LIST_HEIGHT = 448

const searchText = (resource: ManagedResource): string =>
  `${resource.name} ${resource.description} ${resource.id}`.toLowerCase()

export const filterResources = (
  resources: ReadonlyArray<ManagedResource>,
  { query, kind, source }: ResourceFilter
): ReadonlyArray<ManagedResource> => {
  const needle = query.trim().toLowerCase()
  return resources.filter((resource) =>
    (kind === "all" || resource.kind === kind) &&
    (source === "all" || resource.provenance.origin === source) &&
    (needle === "" || searchText(resource).includes(needle))
  )
}

const scopeLabel = (resource: ManagedResource): string =>
  resource.scope.kind === "device-local"
    ? `Device · ${resource.scope.targetId}`
    : resource.scope.allowedTargets.length === 0
      ? "Portable · all targets"
      : `Portable · ${resource.scope.allowedTargets.join(", ")}`

const capitalize = (value: string): string => value[0]!.toUpperCase() + value.slice(1)

const KIND_LABELS: ReadonlyArray<{ readonly value: ResourceKindFilter; readonly label: string }> = [
  { value: "all", label: "All" },
  { value: "prompt", label: "Agents" },
  { value: "skill", label: "Skills" }
]

const getKey = (resource: ManagedResource): string => `${resource.kind}:${resource.id}`
const getText = (resource: ManagedResource): string => resource.name
const ignoreSelect = () => undefined

const useFilterOptions = (resources: ReadonlyArray<ManagedResource>, filter: ResourceFilter) =>
  useMemo(() => {
    const count = (patch: Partial<ResourceFilter>) => filterResources(resources, { ...filter, ...patch }).length
    const kinds: ReadonlyArray<FilterChipOption<ResourceKindFilter>> = KIND_LABELS.map(({ value, label }) => ({
      value,
      label,
      count: count({ kind: value })
    }))
    const origins = [...new Set(resources.map(({ provenance }) => provenance.origin))].sort()
    const sources: ReadonlyArray<FilterChipOption<ResourceSourceFilter>> = [
      { value: "all", label: "All sources", count: count({ source: "all" }) },
      ...origins.map((origin) => ({ value: origin, label: capitalize(origin), count: count({ source: origin }) }))
    ]
    return { kinds, sources }
  }, [resources, filter])

function ResourceRow({
  resource,
  disabled,
  onSetEnabled,
  onReveal,
  onRemove
}: {
  readonly resource: ManagedResource
  readonly disabled: boolean
  readonly onSetEnabled: (selector: ManagedResourceSelector, enabled: boolean) => void
  readonly onReveal: (selector: ManagedResourceSelector) => void
  readonly onRemove: (selector: ManagedResourceSelector) => void
}) {
  const selector = { id: resource.id }
  return (
    <div className="grid w-full grid-cols-[36px_minmax(0,1fr)_44px_88px_88px] items-center gap-3 border-b border-hairline px-4">
      <span className="flex size-9 items-center justify-center rounded-md bg-sunken text-blue"><Boxes size={17} /></span>
      <div className="min-w-0 flex-1">
        <strong className="block truncate text-[12px] text-text-bright">{resource.name}</strong>
        <span className="block truncate text-[10px] text-muted-foreground">
          {resource.kind} · {capitalize(resource.provenance.origin)} · {scopeLabel(resource)} · {resource.trust}
        </span>
      </div>
      <span className="flex justify-center">
        <Toggle
          checked={resource.enabled}
          onCheckedChange={(enabled) => onSetEnabled(selector, enabled)}
          aria-label={`${resource.enabled ? "Disable" : "Enable"} ${resource.name}`}
          disabled={disabled}
        />
      </span>
      <span className="flex justify-end">
        <Button aria-label={`Reveal ${resource.name}`} variant="ghost" size="sm" onClick={() => onReveal(selector)} disabled={disabled}>
          <FolderOpen size={13} /> Reveal
        </Button>
      </span>
      <span className="flex justify-end">
        <Button aria-label={`Remove ${resource.name}`} variant="ghost" size="sm" onClick={() => onRemove(selector)} disabled={disabled}>
          <Trash2 size={13} /> Remove
        </Button>
      </span>
    </div>
  )
}

export interface AgentsResourceListProps extends ResourceFilter {
  readonly resources: ReadonlyArray<ManagedResource>
  readonly loading: boolean
  readonly onQueryChange: (query: string) => void
  readonly onKindChange: (kind: ResourceKindFilter) => void
  readonly onSourceChange: (source: ResourceSourceFilter) => void
  readonly onSetEnabled: (selector: ManagedResourceSelector, enabled: boolean) => void
  readonly onReveal: (selector: ManagedResourceSelector) => void
  readonly onRemove: (selector: ManagedResourceSelector) => void
}

/** Searchable, filterable, windowed list of imported agents and skills. */
export function AgentsResourceList(props: AgentsResourceListProps) {
  const { resources, loading, query, kind, source, onSetEnabled, onReveal, onRemove } = props
  const filter = useMemo(() => ({ query, kind, source }), [query, kind, source])
  const visible = useMemo(() => filterResources(resources, filter), [resources, filter])
  const options = useFilterOptions(resources, filter)
  const renderRow = useCallback(
    (resource: ManagedResource) => (
      <ResourceRow resource={resource} disabled={loading} onSetEnabled={onSetEnabled} onReveal={onReveal} onRemove={onRemove} />
    ),
    [loading, onSetEnabled, onReveal, onRemove]
  )

  if (resources.length === 0) {
    return (
      <div className="overflow-hidden rounded-lg border border-line bg-panel">
        <p className="px-4 py-10 text-center text-[12px] text-muted-foreground">
          {loading ? "Loading managed resources…" : "No managed resources imported."}
        </p>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-3">
      <SearchField
        value={query}
        onChange={props.onQueryChange}
        placeholder="Search agents & skills…"
        count={`${visible.length} results`}
      />
      <FilterChips options={options.kinds} value={kind} onChange={props.onKindChange} ariaLabel="Filter by kind" />
      <FilterChips options={options.sources} value={source} onChange={props.onSourceChange} ariaLabel="Filter by source" />
      <div className="overflow-hidden rounded-lg border border-line bg-panel">
        <VirtualList
          items={visible}
          getKey={getKey}
          getText={getText}
          renderRow={renderRow}
          onSelect={ignoreSelect}
          ariaLabel="Agents and skills"
          empty="No agents or skills match these filters."
          rowHeight={ROW_HEIGHT}
          maxHeight={LIST_HEIGHT}
        />
      </div>
    </div>
  )
}
