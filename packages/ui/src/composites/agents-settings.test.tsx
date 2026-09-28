import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { JINGLER_SUBAGENT_NAMES, ManagedResourceId, ProviderId, ProviderModelId } from "@jingler/core"
import { Schema } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import { AgentsSettings } from "./agents-settings.js"

afterEach(cleanup)

const resourceId = Schema.decodeUnknownSync(ManagedResourceId)("review")
const candidateId = Schema.decodeUnknownSync(ManagedResourceId)("deploy")

describe("AgentsSettings", () => {
  it("reviews detected resources and manages imported resources", () => {
    const onImportSelected = vi.fn()
    const onSetEnabled = vi.fn()
    const onSetModel = vi.fn()
    const sol = ProviderModelId.make("openai-codex/gpt-5.6-sol")
    const unavailable = ProviderModelId.make("openai-codex/retired")
    const haiku = ProviderModelId.make("anthropic/claude-haiku")
    render(<AgentsSettings
      models={[{
        providerId: ProviderId.make("openai-codex"),
        id: sol,
        label: "GPT-5.6 Sol",
        capabilities: { contextWindow: 200_000, reasoning: ["high"], vision: true },
        verification: "certified",
        selectable: true,
        certificationKey: "sol"
      }, {
        providerId: ProviderId.make("anthropic"),
        id: haiku,
        label: "Claude Haiku",
        capabilities: { contextWindow: 200_000, reasoning: [], vision: true },
        verification: "certified",
        selectable: true,
        certificationKey: "haiku"
      }]}
      modelAssignments={{ [ProviderId.make("openai-codex")]: { reviewer: unavailable } }}
      delegationEnabled
      resources={[{
        id: resourceId, kind: "prompt", name: "Review", description: "Review", enabled: true,
        trust: "operator-approved", scope: { kind: "portable", allowedTargets: [] },
        managedPath: "/managed/review.md", byteLength: 6,
        provenance: { origin: "jingler", sourceRoot: "/managed", sourcePath: "/source/review.md", importedAt: null }
      }]}
      detection={{ candidates: [{
        id: candidateId, kind: "skill", name: "Deploy", description: "Deploy", byteLength: 6,
        provenance: { origin: "claude", sourceRoot: "/source", sourcePath: "/source/deploy/SKILL.md", importedAt: null }
      }], skipped: [] }}
      selectedCandidateIds={new Set([candidateId])}
      loading={false}
      reviewing
      onDetect={vi.fn()}
      onSetDelegationEnabled={vi.fn()}
      onSetModel={onSetModel}
      onToggleCandidate={vi.fn()}
      onImportSelected={onImportSelected}
      onCancelDetection={vi.fn()}
      onSetEnabled={onSetEnabled}
      onReveal={vi.fn()}
      onRemove={vi.fn()}
      onRetry={vi.fn()}
    />)
    expect((screen.getByRole("combobox", { name: "openai-codex Reviewer model" }) as HTMLSelectElement).value)
      .toBe(unavailable)
    expect(screen.getAllByRole("combobox")).toHaveLength(JINGLER_SUBAGENT_NAMES.length * 2)
    fireEvent.change(screen.getByRole("combobox", { name: "anthropic Worker model" }), {
      target: { value: haiku }
    })
    fireEvent.click(screen.getByRole("button", { name: "Import 1" }))
    fireEvent.click(screen.getByRole("switch", { name: "Disable Review" }))
    expect(onSetModel).toHaveBeenCalledWith(ProviderId.make("anthropic"), "worker", haiku)
    expect(onImportSelected).toHaveBeenCalledOnce()
    expect(onSetEnabled).toHaveBeenCalledWith({ id: resourceId }, false)
  })

})
