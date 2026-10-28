import { expect, it, vi } from "vitest"
import { resolveImportDismissed } from "./mcp-import-dismissal.js"

it("treats the legacy flag as dismissed and migrates it", async () => {
  const persist = vi.fn(async () => {})
  expect(await resolveImportDismissed(async () => false, persist, () => true)).toBe(true)
  expect(persist).toHaveBeenCalledOnce()
})

it("otherwise reads the persisted value, failing open to not dismissed", async () => {
  const persist = vi.fn(async () => {})
  expect(await resolveImportDismissed(async () => true, persist, () => false)).toBe(true)
  expect(await resolveImportDismissed(async () => false, persist, () => false)).toBe(false)
  expect(await resolveImportDismissed(async () => { throw new Error("x") }, persist, () => false)).toBe(false)
  expect(persist).not.toHaveBeenCalled()
})
