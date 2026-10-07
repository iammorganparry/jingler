import { mkdtemp, readFile, rm, writeFile, symlink, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { checkpointFiles } from "./checkpoint-file-tools.js"
import { anchoredFs } from "./anchored-fs.js"

const roots: string[] = []
const fixture = async () => { const root = await mkdtemp(join(tmpdir(), "checkpoint-files-")); roots.push(root); return root }
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
it.each(["$&", "$$", "$`", "$'"])("edits literal %s identically in single and all replacement", async replacement => {
  const root = await fixture()
  for (const all of [false, true]) {
    await writeFile(join(root, "file"), "before OLD after")
    await checkpointFiles.edit(root, "file", "OLD", replacement, all)
    expect(await readFile(join(root, "file"), "utf8")).toBe(`before ${replacement} after`)
  }
})
it("safe write creates missing ancestors but refuses symlink ancestors", async () => {
  const root = await fixture()
  expect(await anchoredFs.stat(join(root, "missing/nested/file"))).toBeNull()
  await checkpointFiles.write(root, "missing/nested/file", "new")
  expect(await readFile(join(root, "missing/nested/file"), "utf8")).toBe("new")
  await mkdir(join(root, "external"))
  await symlink(join(root, "external"), join(root, "redirect"))
  await expect(anchoredFs.stat(join(root, "redirect/missing/file"))).rejects.toThrow("ancestor")
  await expect(checkpointFiles.write(root, "redirect/missing/file", "unsafe")).rejects.toThrow("ancestor")
  expect(await anchoredFs.stat(join(root, "external/missing"))).toBeNull()
})
it("rename refuses a destination created after the public precheck", async () => {
  const root = await fixture(); const source = join(root, "source"); const target = join(root, "target")
  await writeFile(source, "source bytes")
  const original = anchoredFs.renameNoClobber
  vi.spyOn(anchoredFs, "renameNoClobber").mockImplementation(async (from, to) => {
    await writeFile(to, "late destination")
    return original(from, to)
  })
  await expect(checkpointFiles.rename(root, "source", "target")).rejects.toThrow()
  expect(await readFile(target, "utf8")).toBe("late destination")
  expect(await readFile(source, "utf8")).toBe("source bytes")
  vi.restoreAllMocks()
  await rm(target)
  await checkpointFiles.rename(root, "source", "target")
  expect(await readFile(target, "utf8")).toBe("source bytes")
  expect(await anchoredFs.stat(source)).toBeNull()
})
it("no-clobber rename refuses source symlinks and cross-directory moves", async () => {
  const root = await fixture()
  await writeFile(join(root, "external"), "sentinel")
  await symlink(join(root, "external"), join(root, "source"))
  await expect(anchoredFs.renameNoClobber(join(root, "source"), join(root, "target"))).rejects.toThrow()
  expect(await anchoredFs.stat(join(root, "target"))).toBeNull()
  await mkdir(join(root, "nested"))
  await expect(anchoredFs.renameNoClobber(join(root, "external"), join(root, "nested/target"))).rejects.toThrow("one anchored directory")
  expect(await readFile(join(root, "external"), "utf8")).toBe("sentinel")
})
