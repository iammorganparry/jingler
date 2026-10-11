import { expect, test } from "./fixtures.js";
import { startFakeAuthServer } from "./fake-auth.js";

test("Memory rollout surfaces content-free quality gates and automatic stops", async ({
  launchApp,
}) => {
  const fake = await startFakeAuthServer({ rolloutStopped: true });
  try {
    const { window } = await launchApp({
      authServer: fake,
      configured: true,
      config: { memory: { enabled: true, organizationId: "org-e2e" } },
    });

    await window.getByTestId("memory-sidebar-item").click();
    await expect(
      window.getByRole("heading", { name: "Memory overview" }),
    ).toBeVisible();
    await expect(
      window.getByRole("heading", {
        name: "Memory rollout automatically stopped",
      }),
    ).toBeVisible();
    await expect(
      window.getByText(/auto publication, extraction review remain disabled/),
    ).toBeVisible();

    await window.getByRole("button", { name: "View analytics" }).click();
    await expect(
      window.getByRole("heading", { name: "Memory analytics" }),
    ).toBeVisible();
    await expect(
      window.getByRole("row", { name: /Weekly proposal recall 75%/ }),
    ).toBeVisible();
    await expect(
      window.getByRole("row", { name: /Weekly accept as-is 92%/ }),
    ).toBeVisible();
    await expect(
      window.getByRole("row", { name: /Sensitive escapes 0/ }),
    ).toBeVisible();
    await expect(
      window.getByRole("row", { name: /Stopped rollout arms 2/ }),
    ).toBeVisible();
    await expect(window.getByText(/transcript content/i)).toHaveCount(0);
  } finally {
    await fake.close();
  }
});
