import { execFile } from "node:child_process"
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { promisify } from "node:util"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { PromptCompiler } from "./prompt-compiler.js"
import { instructionLayers, ruleScope } from "./project-instructions.js"

const execFileAsync = promisify(execFile)
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const tempDir = async (label = "root"): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), `jingler-project-instructions-${label}-`))
  roots.push(dir)
  return dir
}

/** The temp root doubles as an empty home so the operator's real ~/.claude never leaks in. */
const layers = (root: string, home = root) => instructionLayers(root, home)
const content = async (root: string, home = root) =>
  (await layers(root, home)).map((layer) => layer.content).join("\n\n")

describe("project instructions", () => {
  it("loads workspace-root AGENTS.md before CLAUDE.md", async () => {
    const root = await tempDir()
    await writeFile(join(root, "AGENTS.md"), "Run focused tests.")
    await writeFile(join(root, "CLAUDE.md"), "Use the package scripts.")

    const [layer] = await layers(root)

    expect(layer).toMatchObject({
      id: "workspace.project-instructions",
      kind: "workspace",
      trust: "untrusted",
      required: false
    })
    expect(layer!.content).toContain("Run focused tests.")
    expect(layer!.content).toContain("Use the package scripts.")
    expect(layer!.content.indexOf("## AGENTS.md")).toBeLessThan(layer!.content.indexOf("## CLAUDE.md"))
  })

  it("ignores directories and symlinks instead of reading or blocking on them", async () => {
    const root = await tempDir()
    const outside = await tempDir("outside")
    await mkdir(join(root, "AGENTS.md"))
    await writeFile(join(outside, "CLAUDE.md"), "outside secret")
    await symlink(join(outside, "CLAUDE.md"), join(root, "CLAUDE.md"))

    expect(await layers(root)).toEqual([])
  })

  it.runIf(process.platform !== "win32")(
    "ignores a FIFO without waiting for a writer",
    async () => {
      const root = await tempDir()
      await execFileAsync("mkfifo", [join(root, "AGENTS.md")])

      expect(await layers(root)).toEqual([])
    },
    1_000
  )

  it("marks oversized content and keeps a valid UTF-8 prefix", async () => {
    const root = await tempDir()
    await writeFile(join(root, "AGENTS.md"), `${"a".repeat(32 * 1024 - 1)}😀tail`)

    const text = await content(root)

    expect(text).toContain("[TRUNCATED: AGENTS.md exceeds 32768 bytes]")
    expect(text).not.toContain("�")
    expect(text).not.toContain("😀")
  })

  it("loads user and project Claude rules, skipping repo symlinks, and lists what loaded", async () => {
    const root = await tempDir()
    const home = await tempDir("home")
    const shared = await tempDir("shared")
    await mkdir(join(home, ".claude", "rules"), { recursive: true })
    await writeFile(join(home, ".claude", "CLAUDE.md"), "user memory")
    await writeFile(join(shared, "org.md"), "org rule via user symlink")
    await symlink(shared, join(home, ".claude", "rules", "org"))
    await mkdir(join(root, ".claude", "rules", "managed"), { recursive: true })
    await writeFile(join(root, ".claude", "rules", "managed", "maven.md"), "use the provided tooling")
    await writeFile(join(root, ".claude", "rules", "notes.txt"), "not markdown")
    await symlink(join(shared, "org.md"), join(root, ".claude", "rules", "linked.md"))

    const [project, user] = await layers(root, home)

    expect(project!.content).toContain("Files: .claude/rules/managed/maven.md")
    expect(project!.content).toContain("use the provided tooling")
    expect(user!.id).toBe("workspace.user-instructions")
    expect(user!.content).toContain("Files: ~/.claude/CLAUDE.md, ~/.claude/rules/org/org.md")
    expect(user!.content).toContain("org rule via user symlink")
    const all = `${project!.content}${user!.content}`
    expect(all).not.toContain("not markdown")
    expect(all).not.toContain("linked.md")
  })

  it("keeps project instructions when an oversized user CLAUDE.md fills the budget", async () => {
    const root = await tempDir()
    const home = await tempDir("home")
    await mkdir(join(home, ".claude"), { recursive: true })
    await writeFile(join(home, ".claude", "CLAUDE.md"), "user ".repeat(8_000))
    await writeFile(join(root, "AGENTS.md"), "PROJECT_RULE_MARKER")

    const compiled = new PromptCompiler().compile({
      layers: await layers(root, home),
      tools: [],
      tokenBudget: 4_000
    })

    expect(compiled.text).toContain("PROJECT_RULE_MARKER")
    expect(compiled.text.indexOf("PROJECT_RULE_MARKER")).toBeLessThan(compiled.text.indexOf("user user"))
  })

  it.runIf(process.platform !== "win32" && process.getuid?.() !== 0)(
    "skips an unreadable user rule and still loads project instructions",
    async () => {
      const root = await tempDir()
      const home = await tempDir("home")
      await mkdir(join(home, ".claude", "rules"), { recursive: true })
      const locked = join(home, ".claude", "rules", "locked.md")
      await writeFile(locked, "secret")
      await chmod(locked, 0o000)
      await writeFile(join(root, "AGENTS.md"), "project ok")

      const text = await content(root, home)

      expect(text).toContain("project ok")
      expect(text).toContain("Unreadable, skipped: ~/.claude/rules/locked.md")
      await chmod(locked, 0o600)
    }
  )

  it("reports rules beyond the file limit instead of dropping them silently", async () => {
    const root = await tempDir()
    await mkdir(join(root, ".claude", "rules"), { recursive: true })
    await Promise.all(Array.from({ length: 70 }, (_, index) =>
      writeFile(join(root, ".claude", "rules", `r${String(index).padStart(2, "0")}.md`), `rule ${index}`)))

    const text = await content(root)

    expect(text).toContain("rule 63")
    expect(text).not.toContain("rule 64")
    expect(text).toContain("Rules under .claude/rules exceeded 64 files")
  })

  it("does not loop on a user symlink cycle", async () => {
    const root = await tempDir()
    const home = await tempDir("home")
    const rules = join(home, ".claude", "rules")
    await mkdir(join(rules, "a"), { recursive: true })
    await writeFile(join(rules, "a", "one.md"), "only once")
    await symlink(rules, join(rules, "a", "loop"))

    const text = await content(root, home)

    expect(text.match(/only once/gu)).toHaveLength(1)
  })

  it("labels path-scoped rules with their globs", async () => {
    expect(ruleScope("---\npaths:\n  - \"**/*.ts\"\n  - src/**\n---\nbody")).toBe("**/*.ts, src/**")
    expect(ruleScope("---\npaths: \"**/*.tf,**/*.tfvars\"\n---\nbody")).toBe("**/*.tf, **/*.tfvars")
    expect(ruleScope("no frontmatter")).toBeNull()

    const root = await tempDir()
    await mkdir(join(root, ".claude", "rules"), { recursive: true })
    await writeFile(join(root, ".claude", "rules", "ts.md"), "---\npaths: \"**/*.ts\"\n---\nts only")

    expect(await content(root)).toContain("Scoped rule: apply only when working on files matching **/*.ts.")
  })
})
