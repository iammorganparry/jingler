import { addProject, appShell, expect, test } from "./fixtures.js"

test("empty and saved routine drafts stay editable across live polling", async ({ launchApp }) => {
  const { window, repoPath } = await launchApp({
    configured: true, withRepo: true,
    piFixture: { scenarioId: "workspace-routines", authRoute: "api-key" },
  })
  await expect(appShell(window)).toBeVisible()
  await window.getByTestId("new-session").click()
  await addProject(window, repoPath)
  await window.keyboard.press("Escape")
  await window.getByRole("button", { name: "Account menu" }).click()
  await window.getByRole("menuitem", { name: "Settings" }).click()
  await window.getByRole("button", { name: "Projects", exact: true }).click()
  const routines = window.getByRole("region", { name: "Saved desktop routines" })
  await expect(routines.getByText("No saved routines for this project.")).toBeVisible()
  for (const existing of [false, true]) {
    if (existing) await routines.getByRole("button", { name: "Edit Poll proof", exact: true }).click()
    const name = routines.getByLabel("Name", { exact: true })
    await name.fill(existing ? "Retained edit" : "Poll proof")
    await routines.getByLabel("Prompt", { exact: true }).fill("Inspect README.md")
    const approval = routines.getByRole("checkbox", { name: /I approve these exact settings/ })
    await approval.click()
    await name.focus()
    // Observe every DOM mutation, including a short busy/loading flash between
    // Playwright assertions, over more than two real polling intervals.
    await routines.evaluate((region) => {
      const input = region.querySelector<HTMLInputElement>('input[id="routine-name"]')!
      const faults: string[] = []
      const check = () => {
        const text = region.textContent ?? ""
        const checks = {
          loading: text.includes("Loading routines…"),
          saving: text.includes("Saving…"),
          disabled: input.disabled,
          replaced: !input.isConnected,
          focusLost: document.activeElement !== input,
        }
        for (const [fault, failed] of Object.entries(checks)) {
          if (failed) faults.push(fault)
        }
      }
      const observer = new MutationObserver(check)
      observer.observe(region, { subtree: true, attributes: true, childList: true, characterData: true })
      Object.assign(region, { pollingProof: { faults, observer, started: Date.now() } })
    })
    await expect.poll(async () => routines.evaluate((region) => {
      const proof = (region as HTMLElement & { pollingProof: { faults: string[]; started: number } }).pollingProof
      if (proof.faults.length) throw new Error(proof.faults.join(", "))
      return Date.now() - proof.started
    }), { intervals: [200], timeout: 10000 }).toBeGreaterThan(6500)
    await routines.evaluate((region) => {
      (region as HTMLElement & { pollingProof: { observer: MutationObserver } }).pollingProof.observer.disconnect()
    })
    await expect(name).toHaveValue(existing ? "Retained edit" : "Poll proof")
    await expect(name).toBeFocused()
    await expect(approval).toHaveAttribute("aria-checked", "true")
    await expect(routines.getByRole("button", { name: "Save routine", exact: true })).toBeEnabled()
    if (!existing) {
      await routines.getByRole("button", { name: "Save routine", exact: true }).click()
      await expect(routines.getByRole("button", { name: "Edit Poll proof", exact: true })).toBeVisible()
    }
  }
})
