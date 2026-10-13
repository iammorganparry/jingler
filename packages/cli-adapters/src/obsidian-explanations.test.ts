import { mkdirSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { ExplanationDocument } from "@jingler/core"
import { Effect } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { saveExplanationToObsidian } from "./obsidian-explanations.js"
import { mkTemp, withTempRoot } from "./test-support.js"

const document = (title: string, updatedAt: string): ExplanationDocument => ({
  id: "exp-1",
  sessionId: "s-1",
  producingChatId: "c-1",
  revision: 1,
  title,
  summary: "Summary",
  sections: [],
  updatedAt
})

describe("saveExplanationToObsidian", () => {
  let temp: ReturnType<typeof withTempRoot>
  let vault: ReturnType<typeof mkTemp>
  beforeEach(() => {
    temp = withTempRoot()
    vault = mkTemp("obsidian-vault-")
    mkdirSync(vault.dir, { recursive: true })
  })
  afterEach(() => {
    temp.cleanup()
    vault.cleanup()
  })

  const save = (enabled: boolean, doc: ExplanationDocument, folder = "Jingler/Explanations") =>
    Effect.runPromise(
      saveExplanationToObsidian({
        config: { enabled, folder },
        vaultRoot: vault.dir,
        document: doc,
        sessionTitle: "Session",
        project: "widget",
        branch: "main"
      }).pipe(Effect.provide(temp.layer))
    )
  const folderFiles = () => readdirSync(join(vault.dir, "Jingler", "Explanations"))

  it("writes nothing when the setting is off", async () => {
    expect(await save(false, document("A", "2026-01-01T00:00:00.000Z"))).toBeNull()
    expect(readdirSync(vault.dir)).toEqual([])
  })

  it("writes one note, and re-publishing updates the same file keeping createdAt", async () => {
    const first = await save(true, document("First", "2026-01-01T00:00:00.000Z"))
    const second = await save(true, document("Second", "2026-02-02T00:00:00.000Z"))
    expect(second).toBe(first)
    expect(folderFiles()).toEqual(["explanation-exp-1.md"])
    const note = readFileSync(join(vault.dir, first ?? ""), "utf8")
    expect(note).toContain("# Second")
    expect(note).toContain('createdAt: "2026-01-01T00:00:00.000Z"')
    expect(note).toContain('project: "widget"')
  })

  it("rejects a folder that tries to leave the vault", async () => {
    await expect(save(true, document("A", "2026-01-01T00:00:00.000Z"), "../outside")).rejects.toThrow("plain relative")
  })
})
