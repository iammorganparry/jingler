import { describe, expect, it } from "vitest"
import { createZipArchive } from "./zip.js"

describe("createZipArchive", () => {
  it("stores Markdown paths and wikilinks in a valid ZIP envelope", () => {
    const archive = createZipArchive([
      { path: ".obsidian/app.json", content: "{}" },
      { path: "runbook.md", content: "---\ntitle: Runbook\n---\n\nSee [[Incident Response]].\n" }
    ])
    expect(archive.readUInt32LE(0)).toBe(0x04034b50)
    expect(archive.readUInt32LE(archive.length - 22)).toBe(0x06054b50)
    expect(archive.toString("utf8")).toContain("runbook.md")
    expect(archive.toString("utf8")).toContain("[[Incident Response]]")
  })

  it("rejects paths that could escape the vault", () => {
    expect(() => createZipArchive([{ path: "../secret.md", content: "no" }])).toThrow(
      "Unsafe vault export path"
    )
  })
})
