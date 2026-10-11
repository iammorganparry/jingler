import { expect, test } from "./fixtures.js"
import { startFakeAuthServer } from "./fake-auth.js"

const RELATIONSHIP_SET = "proposal:relationships"
const DEPENDENCY_CLAIM = "Alpha depends on Beta for the accepted architecture contract."
const WIKILINK_CLAIM = "Beta links back to Alpha as the accepted architecture source."
const REJECTED_CLAIM = "This unsupported reverse dependency must be rejected."

test("reviews relationship evidence independently and projects accepted links without broken targets", async ({
  launchApp
}) => {
  const fake = await startFakeAuthServer()
  try {
    const app = await launchApp({
      authServer: fake,
      configured: true,
      config: { memory: { enabled: true, organizationId: "org-e2e" } }
    })

    await app.window.getByTestId("memory-sidebar-item").click()
    await app.window.getByRole("button", { name: /Reviews/ }).click()
    await app.window.getByRole("button", { name: new RegExp(RELATIONSHIP_SET) }).click()

    await expect(app.window.getByRole("heading", { name: "Relationship evidence" })).toBeVisible()
    await expect(app.window.getByText(DEPENDENCY_CLAIM, { exact: true })).toBeVisible()
    await expect(app.window.getByText(WIKILINK_CLAIM, { exact: true })).toBeVisible()

    await app.window
      .getByRole("button", { name: "Reject dependency beta to alpha" })
      .click()
    await expect
      .poll(() => fake.memorySnapshot("org-e2e").reviewDecisions)
      .toContain("relationship:reject:rejected")
    await expect(
      app.window.locator("article").filter({ hasText: REJECTED_CLAIM }).getByText("rejected", { exact: true })
    ).toBeVisible()

    await app.window
      .getByRole("button", { name: "Accept dependency alpha to beta" })
      .click()
    await expect
      .poll(() => fake.memorySnapshot("org-e2e").acceptedRelationshipIds)
      .toContain("relationship:dependency")

    await app.window.getByRole("button", { name: /Reviews/ }).click()
    await app.window.getByRole("button", { name: new RegExp(RELATIONSHIP_SET) }).click()
    await app.window
      .getByRole("button", { name: "Accept wikilink beta to alpha" })
      .click()
    await expect
      .poll(() => fake.memorySnapshot("org-e2e").acceptedRelationshipIds)
      .toEqual(["relationship:dependency", "relationship:wikilink"])

    await app.window.getByRole("button", { name: "Map" }).click()
    await expect(app.window.getByTestId("memory-edge-edge:relationship:dependency")).toBeVisible()
    await expect(app.window.getByTestId("memory-edge-edge:relationship:wikilink")).toBeVisible()
    await expect(app.window.getByTestId("memory-edge-edge:relationship:backlink")).toBeVisible()
    await expect(app.window.getByTestId("memory-node-page:alpha")).toBeVisible()
    await expect(app.window.getByTestId("memory-node-page:beta")).toBeVisible()

    await app.window.getByTestId("memory-edge-edge:relationship:dependency").click()
    await expect(app.window.getByRole("heading", { name: "dependency" })).toBeVisible()
    await expect(app.window.getByText(DEPENDENCY_CLAIM, { exact: true })).toBeVisible()
    await expect(app.window.getByText("reviewer:e2e", { exact: true })).toBeVisible()
    await expect(app.window.getByText("revision:alpha:2", { exact: true })).toBeVisible()

    await app.window.getByRole("button", { name: "Close inspector" }).click()
    await app.window.getByTestId("memory-edge-edge:relationship:backlink").click()
    await expect(app.window.getByRole("heading", { name: "backlink" })).toBeVisible()
    await expect(app.window.getByText(WIKILINK_CLAIM, { exact: true })).toBeVisible()
    expect(fake.memorySnapshot("org-e2e").acceptedRelationshipIds).not.toContain("relationship:reject")

    await app.app.close()
  } finally {
    await fake.close()
  }
})
