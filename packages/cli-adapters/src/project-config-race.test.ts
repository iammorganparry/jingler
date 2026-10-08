import { Effect } from "effect"
import type { Project } from "@jingler/core"
import { afterEach, expect, it, vi } from "vitest"
import { anchoredFs } from "./anchored-fs.js"
import { readProjectConfig } from "./project-config.js"

afterEach(() => vi.restoreAllMocks())

it("refuses Windows before canonicalizing or launching the anchored worker", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32")
  const read = vi.spyOn(anchoredFs, "read")
  const result = await Effect.runPromiseExit(readProjectConfig({ path: "/missing", imported: true } as Project))
  expect(result._tag).toBe("Failure")
  expect(JSON.stringify(result)).toContain("Windows is unsupported")
  expect(read).not.toHaveBeenCalled()
})

it.each([false, undefined])("requires imported true for local registrations: %s", async (imported) => {
  const read = vi.spyOn(anchoredFs, "read")
  expect((await Effect.runPromiseExit(readProjectConfig({ path: "/missing", imported } as Project)))._tag).toBe("Failure")
  expect(read).not.toHaveBeenCalled()
})
