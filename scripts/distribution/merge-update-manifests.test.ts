import { describe, expect, it } from "vitest"
import { mergeUpdateManifests } from "./merge-update-manifests.mjs"

const manifest = (version: string, file: string, size: number) =>
  [
    `version: ${version}`,
    "files:",
    `  - url: ${file}`,
    `    sha512: ${file}-sha`,
    `    size: ${size}`,
    `path: ${file}`,
    `sha512: ${file}-sha`,
    "releaseDate: '2026-09-28T00:00:00.000Z'",
    ""
  ].join("\n")

describe("mergeUpdateManifests", () => {
  it("lists every architecture's files under one version", () => {
    const merged = mergeUpdateManifests([
      manifest("0.3.1", "Jingler-0.3.1-arm64.zip", 1),
      manifest("0.3.1", "Jingler-0.3.1-x64.zip", 2)
    ])
    expect(merged).toBe(
      [
        "version: 0.3.1",
        "files:",
        "  - url: Jingler-0.3.1-arm64.zip",
        "    sha512: Jingler-0.3.1-arm64.zip-sha",
        "    size: 1",
        "  - url: Jingler-0.3.1-x64.zip",
        "    sha512: Jingler-0.3.1-x64.zip-sha",
        "    size: 2",
        "path: Jingler-0.3.1-arm64.zip",
        "sha512: Jingler-0.3.1-arm64.zip-sha",
        "releaseDate: '2026-09-28T00:00:00.000Z'",
        ""
      ].join("\n")
    )
  })

  it("drops a file listed twice", () => {
    const one = manifest("0.3.1", "Jingler-0.3.1-arm64.zip", 1)
    expect(mergeUpdateManifests([one, one]).match(/- url:/g)).toHaveLength(1)
  })

  it("refuses manifests from different versions", () => {
    expect(() =>
      mergeUpdateManifests([
        manifest("0.3.1", "a.zip", 1),
        manifest("0.3.2", "b.zip", 1)
      ])
    ).toThrow(/disagree on version/)
  })
})
