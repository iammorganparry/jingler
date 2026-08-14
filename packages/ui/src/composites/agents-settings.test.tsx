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
    expect(onSetEnabled).toHaveBeenCalledWith({ kind: "prompt", id: resourceId }, false)
  })

  it("keeps file and MCP resources with the same id independently addressable", () => {
    const onRemove = vi.fn()
    render(<AgentsSettings
      resources={[
        {
          id: resourceId, kind: "prompt", name: "Review prompt", description: "Review", enabled: true,
          trust: "operator-approved", scope: { kind: "portable", allowedTargets: [] },
          managedPath: "/managed/review.md", byteLength: 6,
          provenance: { origin: "jingler", sourceRoot: "/managed", sourcePath: "/source/review.md", importedAt: null }
        },
        {
          id: resourceId, kind: "mcp", name: "Review server", enabled: true,
          trust: "operator-approved", scope: { kind: "portable", allowedTargets: [] },
          provenance: { origin: "jingler", sourceRoot: "/managed", sourcePath: "/source/mcp.json", importedAt: null },
          availability: { state: "available", targetId: "desktop", reason: null },
          transport: "http", url: "https://mcp.example.test", headerKeys: []
        }
      ]}
      detection={null}
      selectedCandidateIds={new Set()}
      loading={false}
      reviewing={false}
      onDetect={vi.fn()}
      onToggleCandidate={vi.fn()}
      onImportSelected={vi.fn()}
      onCancelDetection={vi.fn()}
      onSetEnabled={vi.fn()}
      onReveal={vi.fn()}
      onRemove={onRemove}
      onRetry={vi.fn()}
    />)

    fireEvent.click(screen.getByRole("button", { name: "Remove Review prompt" }))
    fireEvent.click(screen.getByRole("button", { name: "Remove Review server" }))
    expect(onRemove).toHaveBeenCalledWith({ kind: "prompt", id: resourceId })
    expect(onRemove).toHaveBeenCalledWith({ kind: "mcp", id: resourceId })
  })
})
