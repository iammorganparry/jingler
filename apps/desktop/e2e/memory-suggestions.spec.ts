import { expect, test } from "./fixtures.js"
import { startFakeAuthServer } from "./fake-auth.js"

/**
 * Acceptance 07.7 — the inspector's advisory "related pages" suggestions.
 *
 * Two guarantees under test, both structural rather than cosmetic:
 *
 *  1. A suggestion is NON-AUTHORITATIVE. It is rendered in a panel explicitly
 *     labelled "Suggestions · not links", its copy says the pairs are not
 *     accepted edges, and — critically — the suggested pair (alpha ↔
 *     shared-checklist) is one the accepted graph never joins. The accepted
 *     edges out of `alpha` are `alpha→beta` and `alpha→shared-learning`; a
 *     suggestion can therefore never be mistaken for one, because clicking the
 *     accepted edge shows the "accepted relationship / inferred relationships
 *     are not displayed" evidence while the suggestion lives in its own advisory
 *     section.
 *
 *  2. Promoting a suggestion routes through the ORDINARY cited-wikilink page
 *     flow, never a direct graph mutation. "Propose link" opens the inspected
 *     page (where an author adds `[[shared-checklist]]` as a cited wikilink) —
 *     the normal proposal path — rather than accepting an edge in place.
 */

const SUGGESTIONS = "memory-suggestions"

test("inspector related-page suggestions are advisory and promote via the page flow", async ({
  launchApp
}) => {
  // Seed the accepted-learning pages so both endpoints of the advisory pair
  // (alpha, shared-checklist) exist as real accepted pages in org-e2e.
  const fake = await startFakeAuthServer({ acceptedLearningOrganizationIds: ["org-e2e"] })
  try {
    const { window } = await launchApp({
      authServer: fake,
      configured: true,
      config: { memory: { enabled: true, organizationId: "org-e2e" } }
    })

    await window.getByTestId("memory-sidebar-item").click()
    await window.getByRole("button", { name: "Map" }).click()
    await expect(window.getByTestId("memory-map-canvas")).toBeVisible()

    // shared-checklist is an accepted page, but the accepted graph joins it only
    // to shared-learning — never to alpha. That is exactly what makes the
    // alpha↔shared-checklist suggestion advisory rather than an edge.
    await expect(window.getByTestId("memory-node-page:shared-checklist")).toBeVisible()

    // Selecting the node loads the authoritative page detail AND the advisory
    // suggestions for that page into the inspector.
    await window.getByTestId("memory-node-page:alpha").click()
    const inspector = window.getByTestId("memory-inspector")
    await expect(inspector).toContainText("Citations (1)")

    const panel = window.getByTestId(SUGGESTIONS)
    await expect(panel).toBeVisible()
    // Framed unmistakably as NOT accepted evidence.
    await expect(panel).toContainText("Related pages")
    await expect(panel).toContainText("Suggestions · not links")
    await expect(panel).toContainText("These are not accepted edges")
    // Lexical-only wording — the fakes carry no turbopuffer vector layer.
    await expect(panel).toContainText("keyword relatedness")

    // The related endpoint is the OTHER page in the pair, shown with its method
    // and shared-term evidence — never as a graph edge.
    const related = panel.getByRole("button", { name: "shared-checklist" })
    await expect(related).toBeVisible()
    await expect(panel).toContainText("lexical")
    await expect(panel).toContainText("shared: architecture, accepted, route")

    // The suggested endpoint (shared-checklist) is NOT joined to alpha by any
    // accepted edge — the accepted edges out of alpha are alpha→beta and
    // alpha→shared-learning. So the same page appears in the advisory panel while
    // the authoritative graph never links the pair: proof the suggestion is not,
    // and cannot be mistaken for, an accepted edge.
    await expect(window.getByTestId("memory-edge-edge:e2e:alpha-shared")).toBeVisible()
    await expect(
      window.getByTestId("memory-edge-edge:e2e:alpha-shared-checklist")
    ).toHaveCount(0)

    // Promote the suggestion. Promotion must route through the normal
    // page/cited-wikilink flow, not mint an edge in place.
    await window.getByTestId("memory-suggestion-promote").click()

    // We land on the inspected page — the surface where a cited wikilink to the
    // related page is authored and proposed — rather than on any accepted edge.
    const page = window.getByTestId("memory-page")
    await expect(page).toBeVisible()
    await expect(page).toContainText("Alpha memory")
  } finally {
    await fake.close()
  }
})
