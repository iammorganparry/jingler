import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { ManagedResourceId } from "@jingler/core"
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
    render(<AgentsSettings
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
      onToggleCandidate={vi.fn()}
      onImportSelected={onImportSelected}
      onCancelDetection={vi.fn()}
      onSetEnabled={onSetEnabled}
      onReveal={vi.fn()}
      onRemove={vi.fn()}
      onRetry={vi.fn()}
    />)
    fireEvent.click(screen.getByRole("button", { name: "Import 1" }))
    fireEvent.click(screen.getByRole("switch", { name: "Disable Review" }))
    expect(onImportSelected).toHaveBeenCalledOnce()
    expect(onSetEnabled).toHaveBeenCalledWith(resourceId, false)
  })
})
