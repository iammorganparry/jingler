import type { PlanDocument } from "@jingler/core"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { fn } from "storybook/test"
import { OpenAssetProvider } from "../asset/open-asset-context.js"
import { PlanReview } from "./plan-review.js"

const KNOWN_FILES = new Set([
  "packages/contracts/src/index.ts",
  "packages/cli-adapters/src/token-store.ts",
  "packages/cli-adapters/src/token-store.test.ts",
  "apps/desktop/src/main/rpc.ts",
  "apps/desktop/e2e/token-store.spec.ts",
  "services/auth/src/main/java/io/trigify/platform/authentication/keychain/internal/KeychainTokenStoreRepositoryImpl.java"
])

const document: PlanDocument = {
  id: "plannotator:PLAN.md",
  sessionId: "story-session",
  producingChatId: "story-chat",
  revision: 2,
  reviewId: "story-review",
  status: "proposed",
  sourceMarkdown: "# Token store rollout\n- keep the v1 reader\n",
  previousSourceMarkdown: "# Token store rollout\n- drop the v1 reader\n",
  updatedAt: "2026-10-08T00:00:00.000Z",
  updatedBy: "agent",
  plan: {
    title: "Token store rollout",
    annotations: [],
    sections: [
      {
        id: "context",
        title: "Context",
        blocks: [
          {
            kind: "prose",
            id: "c1",
            text: "Auth tokens are written straight to `settings.json` today. That file syncs across devices, so a token copied to a second machine silently signs it in. This plan moves tokens into the OS keychain behind a small `TokenStore` service."
          },
          { kind: "heading", id: "c2", level: 3, text: "Why now" },
          {
            kind: "list",
            id: "c3",
            ordered: false,
            items: ["Two reports of a shared token signing in on a teammate's laptop", "`settings.json` is about to gain cloud sync", "The keychain API is already used for GitHub credentials"]
          }
        ]
      },
      {
        id: "out-of-scope",
        title: "Out of scope",
        blocks: [{ kind: "prose", id: "o1", text: "Rotating existing tokens. Users keep their current session; only storage moves." }]
      }
    ],
    stages: [
      {
        id: "token-store",
        title: "Add the TokenStore service",
        intent: "Store tokens in the keychain.",
        deliverable: "Tokens live in the OS keychain, and the old `settings.json` value is migrated on first read.",
        userStory: { role: "signed-in user", capability: "my token kept out of synced files", benefit: "copying my settings never signs someone else in" },
        approach: [
          "Add `TokenStore` as an `Effect.Service` with `get`, `set` and `clear`",
          "On `get`, fall back to `settings.json` once, write to the keychain, then delete the old value",
          "Wire `AuthService` to read through `TokenStore`"
        ],
        tasks: [
          { id: "t1", text: "Implement `TokenStore`", status: "completed", description: "An `Effect.Service` over the platform keychain with `get`, `set` and `clear`." },
          { id: "t2", text: "Migrate the settings.json value", status: "pending", description: "On first `get`, copy the old value into the keychain, then delete it from `settings.json`. A second read never touches the file." }
        ],
        files: [
          { path: "packages/cli-adapters/src/token-store.ts", change: "A", added: 84 },
          { path: "packages/cli-adapters/src/token-store.test.ts", change: "A", added: 61 },
          { path: "packages/cli-adapters/src/auth-service.ts", change: "M", added: 6, removed: 11 },
          { path: "services/auth/src/main/java/io/trigify/platform/authentication/keychain/internal/KeychainTokenStoreRepositoryImpl.java", change: "M", added: 142, removed: 37 },
          { path: "packages/cli-adapters/src/legacy-token.ts", change: "D", removed: 48 }
        ],
        diagrams: [{ id: "d1", source: "flowchart LR\n  auth[AuthService] --> store[TokenStore]\n  store --> keychain[(Keychain)]\n  store -. once .-> settings[(settings.json)]" }],
        notes: [
          { kind: "prose", id: "n1", text: "The migration is idempotent: a second read finds the keychain entry and never touches `settings.json`." },
          {
            kind: "change",
            id: "n2",
            path: "packages/cli-adapters/src/auth-service.ts",
            patch: "@@ -1,3 +1,3 @@\n-const token = settings.get(\"token\")\n+const token = yield* TokenStore.get\n"
          },
          { kind: "table", id: "n3", headers: ["Platform", "Backend"], rows: [["macOS", "Keychain"], ["Windows", "Credential Manager"], ["Linux", "libsecret"]] }
        ],
        acceptance: [
          {
            id: "a1",
            text: "A token in `settings.json` moves to the keychain on first read",
            testReferences: [{ path: "packages/cli-adapters/src/token-store.test.ts", cases: ["migrates once"], kind: "unit" }],
            status: "passed",
            evidence: null
          },
          { id: "a2", text: "Clearing the store removes the keychain entry", testReferences: [], status: "pending", evidence: null }
        ],
        definitionOfDone: ["Acceptance criteria verified", "`pnpm typecheck` and focused tests pass"],
        complexity: "medium"
      },
      {
        id: "rpc",
        title: "Expose sign-out over RPC",
        intent: "Let the renderer clear the token.",
        deliverable: "The account menu's **Sign out** clears the keychain entry and returns to the login screen.",
        approach: ["Add `signOut` to `JinglerRpcs`", "Handle it in `rpc.ts` by calling `TokenStore.clear`"],
        files: [
          { path: "packages/contracts/src/index.ts", change: "M", added: 4 },
          { path: "apps/desktop/src/main/rpc.ts", change: "M", added: 9, removed: 1 },
          { path: "apps/desktop/e2e/token-store.spec.ts", change: "A" }
        ],
        diagrams: [],
        notes: [],
        acceptance: [{
          id: "b1",
          text: "Signing out lands on the login screen and a relaunch stays signed out",
          testReferences: [{ path: "apps/desktop/e2e/token-store.spec.ts", cases: ["sign out persists"], kind: "e2e" }],
          status: "pending",
          evidence: null
        }],
        definitionOfDone: ["e2e passes locally"],
        dependencies: ["token-store"],
        complexity: "low"
      }
    ]
  }
}

const meta = {
  title: "Screens/Plan Review",
  component: PlanReview,
  parameters: { layout: "fullscreen" },
  args: { document, onApprove: fn(), onRevise: fn() },
  decorators: [
    (Story) => (
      <OpenAssetProvider open={fn()} knownFiles={KNOWN_FILES}>
        <div className="flex h-screen">
          <Story />
        </div>
      </OpenAssetProvider>
    )
  ]
} satisfies Meta<typeof PlanReview>

export default meta
type Story = StoryObj<typeof meta>

export const Proposed: Story = {}

export const Approved: Story = { args: { document: { ...document, status: "approved" } } }

/** Stage 1 finished (every task done, every criterion passed); stage 2 underway. */
export const Executing: Story = {
  args: {
    document: {
      ...document,
      status: "executing",
      plan: {
        ...document.plan,
        stages: document.plan.stages.map((stage, index) => index === 0
          ? {
              ...stage,
              tasks: (stage.tasks ?? []).map((task) => ({ ...task, status: "completed" as const })),
              acceptance: stage.acceptance.map((criterion) => ({ ...criterion, status: "passed" as const }))
            }
          : { ...stage, tasks: [{ id: "r1", text: "Add `signOut` to the contract", status: "in-progress" as const }] })
      }
    }
  }
}
