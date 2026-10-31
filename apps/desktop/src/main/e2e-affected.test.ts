import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { selectSpecs } from "../../scripts/e2e-affected-select.js"

const e2eDir = join(__dirname, "../../e2e")
const allSpecs = readdirSync(e2eDir).filter((name) => name.endsWith(".spec.ts")).sort()
const map = JSON.parse(readFileSync(join(e2eDir, "affected-map.json"), "utf8")) as Array<{ paths: string[]; specs: string[] }>

describe("affected-map.json", () => {
  it("names only specs that exist", () => {
    const missing = map.flatMap((entry) => entry.specs).filter((name) => !allSpecs.includes(name))
    expect(missing).toEqual([])
  })
})

describe("selectSpecs", () => {
  it("selects only the mapped specs for a UI change", () => {
    const { specs } = selectSpecs(["packages/ui/src/app/terminal-panel.tsx"], map, allSpecs)
    expect(specs).toEqual(["agent-command-terminal.spec.ts", "editor-groups.spec.ts", "terminal.spec.ts", "workspace-terminal-archive.spec.ts"])
  })

  it("runs everything for an unmapped path", () => {
    expect(selectSpecs(["tools/unknown/thing.ts"], map, allSpecs).specs).toEqual(allSpecs)
  })

  it.each(["pnpm-lock.yaml", "packages/ui/package.json", "apps/desktop/e2e/fixtures.ts", "apps/desktop/src/main/e2e/pi-fixture.ts", "apps/desktop/e2e/affected-map.json"])(
    "runs everything when %s changes",
    (path) => {
      expect(selectSpecs([path, "packages/ui/src/app/terminal-panel.tsx"], map, allSpecs).specs).toEqual(allSpecs)
    }
  )

  it("runs a changed spec itself", () => {
    expect(selectSpecs(["apps/desktop/e2e/auth.spec.ts"], map, allSpecs).specs).toEqual(["auth.spec.ts"])
  })

  it("selects nothing for docs-only changes", () => {
    expect(selectSpecs(["docs/ux-audit/05-backlog.md", "README.md"], map, allSpecs).specs).toEqual([])
  })
})
