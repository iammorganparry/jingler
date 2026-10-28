import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { ManagedResourceId, type ManagedResource } from "@jingler/core"
import { Schema } from "effect"
import { useState } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  AgentsResourceList,
  filterResources,
  type ResourceKindFilter,
  type ResourceSourceFilter
} from "./agents-resource-list.js"

afterEach(cleanup)

const ORIGINS = ["claude", "codex"] as const
const resources: ReadonlyArray<ManagedResource> = Array.from({ length: 500 }, (_, i) => {
  const origin = ORIGINS[i % 2]!
  return {
    id: Schema.decodeUnknownSync(ManagedResourceId)(`res-${i}`),
    kind: i % 5 === 0 ? "prompt" : "skill",
    name: `Resource ${i}`,
    description: "d",
    enabled: true,
    trust: "operator-approved",
    scope: { kind: "portable", allowedTargets: [] },
    managedPath: `/m/${i}.md`,
    byteLength: 1,
    provenance: { origin, sourceRoot: "/s", sourcePath: `/s/${i}.md`, importedAt: null }
  } satisfies ManagedResource
})

describe("filterResources", () => {
  it("combines query, kind, and source", () => {
    const base = { query: "", kind: "all", source: "all" } as const
    expect(filterResources(resources, base)).toHaveLength(500)
    expect(filterResources(resources, { ...base, kind: "prompt" })).toHaveLength(100)
    expect(filterResources(resources, { ...base, kind: "prompt", source: "claude" })).toHaveLength(50)
    expect(filterResources(resources, { query: "resource 10", kind: "skill", source: "codex" }))
      .toEqual(resources.filter(({ name, kind, provenance }) =>
        name.toLowerCase().includes("resource 10") && kind === "skill" && provenance.origin === "codex"))
  })
})

describe("AgentsResourceList", () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(448)
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(600)
  })

  const Harness = ({ onRemove = vi.fn() }: { onRemove?: () => void }) => {
    const [query, setQuery] = useState("")
    const [kind, setKind] = useState<ResourceKindFilter>("all")
    const [source, setSource] = useState<ResourceSourceFilter>("all")
    return (
      <AgentsResourceList
        resources={resources} loading={false}
        query={query} kind={kind} source={source}
        onQueryChange={setQuery} onKindChange={setKind} onSourceChange={setSource}
        onSetEnabled={vi.fn()} onReveal={vi.fn()} onRemove={onRemove}
      />
    )
  }

  it("windows 500 entries, shows counts, and narrows with combined filters", () => {
    render(<Harness />)
    expect(screen.getAllByRole("option").length).toBeLessThan(40)
    expect(screen.getByRole("radio", { name: "All 500" })).toBeTruthy()
    expect(screen.getByRole("radio", { name: "Agents 100" })).toBeTruthy()
    fireEvent.click(screen.getByRole("radio", { name: "Agents 100" }))
    fireEvent.click(screen.getByRole("radio", { name: "Claude 50" }))
    expect(screen.getByRole("radio", { name: "Agents 50" })).toBeTruthy()
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Resource 10" } })
    expect(screen.getByText("2 results")).toBeTruthy()
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "zzz" } })
    expect(screen.getByText("No agents or skills match these filters.")).toBeTruthy()
  })

  it("removes a row", () => {
    const onRemove = vi.fn()
    render(<Harness onRemove={onRemove} />)
    fireEvent.click(screen.getByRole("button", { name: "Remove Resource 0" }))
    expect(onRemove).toHaveBeenCalledWith({ id: "res-0" })
  })
})
