import { startBetterAuthTestServer } from "@jingler/server/test-support/better-auth-account"
import { appShell, expect, test } from "./fixtures.js"

test("a native Better Auth test account enters the real app without email", async ({
  launchApp
}) => {
  const auth = await startBetterAuthTestServer()
  try {
    const { completeDeepLinkSignIn, window } = await launchApp({
      authSessionServer: auth,
      configured: true,
      signedIn: false,
      withRepo: true
    })

    await expect(
      window.getByRole("heading", { name: "Sign in to Jingler" })
    ).toBeVisible()
    await completeDeepLinkSignIn()
    await expect(appShell(window)).toBeVisible()

    const account = window.getByRole("button", { name: "Account menu" })
    await expect(account.getByText("Jingler E2E")).toBeVisible()
    await expect(account.getByText(auth.email)).toBeVisible()
  } finally {
    await auth.close()
  }
})
