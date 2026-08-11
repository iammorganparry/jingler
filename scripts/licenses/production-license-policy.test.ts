import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  inspectProductionLicenses,
  piAttributionIssues
} from "./production-license-policy.mjs"

const roots: Array<string> = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const fixture = async (dependencies: Record<string, string>) => {
  const root = await mkdtemp(join(tmpdir(), "jingler-license-policy-"))
  roots.push(root)
  await mkdir(join(root, "apps", "desktop"), { recursive: true })
  await writeFile(join(root, "apps", "desktop", "package.json"), JSON.stringify({
    name: "@fixture/desktop",
    private: true,
    dependencies: Object.fromEntries(Object.keys(dependencies).map((name) => [name, "1.0.0"]))
  }))
  await Promise.all(Object.entries(dependencies).map(async ([name, license]) => {
    const directory = join(root, "node_modules", ...name.split("/"))
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, "package.json"), JSON.stringify({ name, version: "1.0.0", license }))
  }))
  return root
}

describe("production dependency license policy", () => {
  it("accepts the reviewed permissive production graph", async () => {
    const report = await inspectProductionLicenses(await fixture({
      "allowed-mit": "MIT",
      "allowed-composite": "MIT OR Apache-2.0"
    }))
    expect(report.issues).toEqual([])
    expect(report.packages).toHaveLength(2)
  })

  it("rejects prohibited and unknown production licenses", async () => {
    const report = await inspectProductionLicenses(await fixture({
      "prohibited-package": "AGPL-3.0",
      "unknown-package": "SEE LICENSE IN LICENSE"
    }))
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.stringContaining("prohibited license AGPL-3.0"),
      expect.stringContaining("unknown license SEE LICENSE IN LICENSE")
    ]))
  })

  it("requires package-version and full pi attribution", () => {
    const packages = [
      { name: "@earendil-works/pi-ai", version: "0.84.1" },
      { name: "@earendil-works/pi-coding-agent", version: "0.84.1" }
    ]
    expect(piAttributionIssues("", packages)).toHaveLength(4)
    expect(piAttributionIssues([
      "@earendil-works/pi-ai@0.84.1",
      "@earendil-works/pi-coding-agent@0.84.1",
      "MIT License",
      "Copyright (c) 2025 Mario Zechner"
    ].join("\n"), packages)).toEqual([])
  })
})
