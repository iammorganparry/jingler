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

  it("rejects drive- and scheme-qualified and encoded-traversal entries", () => {
    for (const path of ["C:/secret.md", "file:x", "%2e%2e/secret.md", "%252e%252e/secret.md"]) {
      expect(() => createZipArchive([{ path, content: "no" }])).toThrow("Unsafe vault export path")
    }
  })

  it("writes a valid fixed DOS timestamp into the local header", () => {
    const archive = createZipArchive([{ path: "runbook.md", content: "{}" }])
    // Local header mod-time at offset 10, mod-date at offset 12 (first entry).
    expect(archive.readUInt16LE(10)).toBe(0x0000)
    expect(archive.readUInt16LE(12)).toBe(0x0021)
  })

  it("rejects a path longer than the 16-bit name-length field", () => {
    const path = `${"a".repeat(0x1_0000)}.md`
    expect(() => createZipArchive([{ path, content: "x" }])).toThrow("exceeds")
  })

  it("rejects duplicate archive paths case-insensitively", () => {
    expect(() => createZipArchive([
      { path: "_jingler/Index.md", content: "generated" },
      { path: "_JINGLER/index.md", content: "user" }
    ])).toThrow("Duplicate vault export path")
  })
})
