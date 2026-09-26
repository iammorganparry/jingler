import type { Page } from "@playwright/test"
import { appShell, expect, sessionRow, test } from "./fixtures.js"
import type { SeedSession } from "./fixtures.js"
import { startFakeAuthServer } from "./fake-auth.js"

/**
 * Optional sign-in. The app boots signed out straight into the shell; the
 * sidebar footer's "Sign in" opens the sign-in dialog. These assert the
 * magic-link flow reaches its "sent" state, and a `jingler://` deep-link
 * callback signs the user in and closes the dialog. All offline: the fixture
 * runs a fake auth backend and a plaintext token store.
 */

const seeded: SeedSession = {
  id: "s_auth_1",
  repo: "widget",
  branch: "chore/seed",
  title: "Seeded session",
  status: "idle",
  diff: { added: 0, removed: 0 },
  prNumber: null,
  costUsd: 0,
  tokens: 0,
  updatedAt: "2026-07-11T00:00:00.000Z"
}

const signedOutApp = { signedIn: false, configured: true, withRepo: true, sessions: [seeded] } as const

const signInHeading = (window: Page) => window.getByRole("heading", { name: "Sign in to Jingler" })

/** Open the sign-in dialog from the sidebar footer. */
async function openSignIn(window: Page) {
  await expect(appShell(window)).toBeVisible()
  await window.getByRole("button", { name: "Sign in", exact: true }).click()
  await expect(signInHeading(window)).toBeVisible()
}

test("signed out boots into the app with Sign in in the sidebar", async ({ launchApp }) => {
  const { window } = await launchApp(signedOutApp)
  await expect(appShell(window)).toBeVisible()
  await expect(sessionRow(window, "Seeded session")).toBeVisible()
  await expect(signInHeading(window)).toHaveCount(0)
  await expect(window.getByRole("button", { name: "Account menu" })).toHaveCount(0)

  await openSignIn(window)
  await expect(window.getByRole("button", { name: /continue with github/i })).toBeVisible()
  await expect(window.getByRole("button", { name: /continue with google/i })).toBeVisible()

  // Dismissable: signing in is never required.
  await window.keyboard.press("Escape")
  await expect(signInHeading(window)).toHaveCount(0)
  await expect(appShell(window)).toBeVisible()
})

test("requesting a magic link shows the sent confirmation", async ({ launchApp }) => {
  const { window, authServer } = await launchApp(signedOutApp)
  await openSignIn(window)
  await window.getByPlaceholder("you@company.com").fill("founder@example.com")
  await window.getByRole("button", { name: /send magic link/i }).click()
  await expect(window.getByText(/sign-in link sent to/i)).toBeVisible()
  await expect(window.getByText("founder@example.com")).toBeVisible()
  expect(authServer.sentEmails).toContain("founder@example.com")
})

test("a rejected magic-link request shows the error state", async ({ launchApp }) => {
  const { window } = await launchApp(signedOutApp)
  await openSignIn(window)
  // The fake backend rejects any address containing "fail".
  await window.getByPlaceholder("you@company.com").fill("fail@example.com")
  await window.getByRole("button", { name: /send magic link/i }).click()
  await expect(window.getByText(/couldn't send the sign-in link/i)).toBeVisible()
  // Still in the dialog, and can retry.
  await expect(signInHeading(window)).toBeVisible()
})

test("OAuth opens the provider URL and the callback signs in", async ({ launchApp }) => {
  const { window, app, authServer, completeDeepLinkSignIn } = await launchApp(signedOutApp)
  await openSignIn(window)
  // Stub shell.openExternal in the main process so no real browser opens, and
  // record what the OAuth flow asked to open.
  await app.evaluate(({ shell }) => {
    ;(globalThis as unknown as { __opened: Array<string> }).__opened = []
    shell.openExternal = async (url: string) => {
      ;(globalThis as unknown as { __opened: Array<string> }).__opened.push(url)
    }
  })
  await window.getByRole("button", { name: /continue with github/i }).click()

  // The provider URL (from the fake backend's /sign-in/social) was opened.
  await expect
    .poll(() => app.evaluate(() => (globalThis as unknown as { __opened: Array<string> }).__opened))
    .toContainEqual(expect.stringContaining("/desktop/callback"))
  expect(authServer.url).toContain("127.0.0.1")

  // The browser flow returns via the deep link → signed in → dialog closes.
  await completeDeepLinkSignIn()
  await expect(signInHeading(window)).toHaveCount(0)
  await expect(window.getByRole("button", { name: "Account menu" })).toBeVisible()
})

test("an unavailable OAuth provider explains that email sign-in still works", async ({
  launchApp,
}) => {
  const authServer = await startFakeAuthServer({
    unavailableSocialProviders: ["github"],
  })
  try {
    const { window } = await launchApp({ ...signedOutApp, authServer })
    await openSignIn(window)
    await window.getByRole("button", { name: /continue with github/i }).click()
    await expect(
      window.getByText("GitHub sign-in is unavailable. Use email instead."),
    ).toBeVisible()
    await expect(window.getByPlaceholder("you@company.com")).toBeVisible()
  } finally {
    await authServer.close()
  }
})

test("a deep-link callback signs in and shows the account menu", async ({ launchApp }) => {
  const { window, completeDeepLinkSignIn } = await launchApp(signedOutApp)
  await openSignIn(window)
  // The OS hands back the jingler:// callback → signed in → dialog closes.
  await completeDeepLinkSignIn()
  await expect(signInHeading(window)).toHaveCount(0)
  const account = window.getByRole("button", { name: "Account menu" })
  await expect(account.getByText("E2E User")).toBeVisible()
  await expect(sessionRow(window, "Seeded session")).toBeVisible()
})

test("a stored token boots signed in", async ({ launchApp }) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: [seeded] })
  await expect(appShell(window)).toBeVisible()
  await expect(window.getByRole("button", { name: "Account menu" })).toBeVisible()
  await expect(window.getByRole("button", { name: "Sign in", exact: true })).toHaveCount(0)
})

test("the account menu shows the user and signs out", async ({ launchApp }) => {
  const { window } = await launchApp({ configured: true, withRepo: true, sessions: [seeded] })
  await expect(appShell(window)).toBeVisible()

  // The footer account menu shows the signed-in user (from the fake backend).
  const account = window.getByRole("button", { name: "Account menu" })
  await expect(account.getByText("E2E User")).toBeVisible()
  await expect(account.getByText("e2e@jingler.dev")).toBeVisible()

  // Open it and sign out → still in the app, now offering Sign in.
  await account.click()
  await window.getByRole("menuitem", { name: /sign out/i }).click()
  await expect(window.getByRole("button", { name: "Sign in", exact: true })).toBeVisible()
  await expect(appShell(window)).toBeVisible()
  await expect(signInHeading(window)).toHaveCount(0)
})
