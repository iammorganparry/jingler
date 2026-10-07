import { isAbsolute, join } from "node:path"
import { anchoredFs } from "./anchored-fs.js"
import { ToolError } from "./runtime/tools/tool-registry.js"
const file = (cwd: string, requested: string) => {
  if (!requested || isAbsolute(requested) || requested.includes("\\") || requested.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) throw new ToolError("forbidden", "Unsafe workspace file path.")
  return join(cwd, requested)
}
export const checkpointFiles = {
  write: async (cwd: string, requested: string, content: string) => {
    const target = file(cwd, requested); const info = await anchoredFs.stat(target)
    await anchoredFs.write(target, content, info?.mode ?? 0o600)
    return { path: requested }
  },
  edit: async (cwd: string, requested: string, oldText: string, newText: string, replaceAll: boolean) => {
    if (!oldText) throw new ToolError("invalid-input", "Edit oldText must not be empty.")
    const target = file(cwd, requested); const current = await anchoredFs.read(target)
    const text = current.bytes.toString("utf8"); const matches = text.split(oldText).length - 1
    if (!matches || (!replaceAll && matches !== 1)) throw new ToolError("invalid-input", "Edit must match existing text exactly and unambiguously.")
    await anchoredFs.write(target, replaceAll ? text.split(oldText).join(newText) : text.replace(oldText, () => newText), current.mode)
    return { path: requested, replacements: replaceAll ? matches : 1 }
  },
  remove: async (cwd: string, requested: string) => {
    const target = file(cwd, requested); if (!(await anchoredFs.stat(target))?.file) throw new ToolError("forbidden", "Only regular workspace files may be deleted.")
    await anchoredFs.unlink(target); return { path: requested }
  },
  rename: async (_cwd: string, _from: string, _to: string): Promise<never> => {
    throw new ToolError("forbidden", "Rename is unsupported in checkpoint-safe mode: an atomic no-overwrite move is unavailable. No files were changed.")
  }
}
