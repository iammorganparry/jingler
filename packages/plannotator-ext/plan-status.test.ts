import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createReviewedContent, persistPlanStatuses } from "./plan-status.ts"

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

describe("persistPlanStatuses", () => {
  it("atomically updates the requested checkbox markers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "plannotator-status-"))
    directories.push(directory)
    const path = join(directory, "PLAN.md")
    await writeFile(path, "- [ ] First\n- [ ] Second\n", "utf8")

    const result = await persistPlanStatuses(path, new Map([
      [1, "completed"],
      [2, "in-progress"]
    ]))

    expect(result).toBe("- [x] First\n- [~] Second\n")
    expect(await readFile(path, "utf8")).toBe(result)
  })

  it("serializes concurrent marker updates without losing either one", async () => {
    const directory = await mkdtemp(join(tmpdir(), "plannotator-status-"))
    directories.push(directory)
    const path = join(directory, "PLAN.md")
    await writeFile(path, "- [ ] First\n- [ ] Second\n", "utf8")

    await Promise.all([
      persistPlanStatuses(path, new Map([[1, "completed"]])),
      persistPlanStatuses(path, new Map([[2, "in-progress"]]))
    ])

    expect(await readFile(path, "utf8")).toBe("- [x] First\n- [~] Second\n")
  })
})

describe("createReviewedContent", () => {
  it("returns the previous reviewed text only when a resubmission changed it", () => {
    const reviewed = createReviewedContent()
    expect(reviewed.begin("PLAN.md", "v1")).toBeNull()
    expect(reviewed.begin("PLAN.md", "v2")).toBe("v1")
    // An unchanged resubmission has nothing to diff.
    expect(reviewed.begin("PLAN.md", "v2")).toBeNull()
    expect(reviewed.begin("PLAN.md", "v3")).toBe("v2")
  })

  it("tracks each plan file separately", () => {
    const reviewed = createReviewedContent()
    reviewed.begin("PLAN.md", "auth v1")
    expect(reviewed.begin("plans/other.md", "other v1")).toBeNull()
    expect(reviewed.begin("PLAN.md", "auth v2")).toBe("auth v1")
  })
})
