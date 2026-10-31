import { mkdtemp, readFile, rm, writeFile, symlink, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { restrictedFiles } from "./restricted-file-tools.js"
import { anchoredFs } from "./anchored-fs.js"

const roots: string[] = []
const fixture = async () => { const root = await mkdtemp(join(tmpdir(), "restricted-files-")); roots.push(root); return root }
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
it.each(["$&", "$$", "$`", "$'"])("edits literal %s identically in single and all replacement", async replacement => {
  const root = await fixture()
  for (const all of [false, true]) {
    await writeFile(join(root, "file"), "before OLD after")
    await restrictedFiles.edit(root, "file", "OLD", replacement, all)
    expect(await readFile(join(root, "file"), "utf8")).toBe(`before ${replacement} after`)
  }
})
it("safe write creates missing ancestors but refuses symlink ancestors", async () => {
  const root = await fixture()
  expect(await anchoredFs.stat(join(root, "missing/nested/file"))).toBeNull()
  await restrictedFiles.write(root, "missing/nested/file", "new")
  expect(await readFile(join(root, "missing/nested/file"), "utf8")).toBe("new")
  await mkdir(join(root, "external"))
  await symlink(join(root, "external"), join(root, "redirect"))
  await expect(anchoredFs.stat(join(root, "redirect/missing/file"))).rejects.toThrow("ancestor")
  await expect(restrictedFiles.write(root, "redirect/missing/file", "unsafe")).rejects.toThrow("ancestor")
  expect(await anchoredFs.stat(join(root, "external/missing"))).toBeNull()
})
it.each([false, true])("safe rename refuses without touching files (destination exists: %s)", async existing => {
  const root = await fixture(); const source = join(root, "source"); const target = join(root, "target")
  await writeFile(source, "source bytes")
  if (existing) await writeFile(target, "destination bytes")
  await expect(restrictedFiles.rename(root, "source", "target")).rejects.toThrow("Rename is unsupported in restricted sessions")
  expect(await readFile(source, "utf8")).toBe("source bytes")
  if (existing) expect(await readFile(target, "utf8")).toBe("destination bytes")
  else expect(await anchoredFs.stat(target)).toBeNull()
})
it("safe rename cannot delete externally replaced source or destination", async () => {
  const root = await fixture(); const source = join(root, "source"); const target = join(root, "target")
  await writeFile(source, "original")
  const refused = expect(restrictedFiles.rename(root, "source", "target")).rejects.toThrow("No files were changed")
  await writeFile(source, "external source")
  await writeFile(target, "external destination")
  await refused
  expect(await readFile(source, "utf8")).toBe("external source")
  expect(await readFile(target, "utf8")).toBe("external destination")
})
it.each([".git/config", ".GIT/config", "a/.Git/hooks/pre-commit"])("refuses Git metadata path %s in any case", async path => {
  const root = await fixture()
  await expect(restrictedFiles.write(root, path, "x")).rejects.toThrow("Unsafe workspace file path")
})
it("refuses writing through an in-workspace symlink to .git", async () => {
  const root = await fixture()
  await mkdir(join(root, ".git"))
  await symlink(join(root, ".git"), join(root, "meta"))
  await expect(restrictedFiles.write(root, "meta/config", "x")).rejects.toThrow("ancestor")
  expect(await anchoredFs.stat(join(root, ".git/config"))).toBeNull()
})
