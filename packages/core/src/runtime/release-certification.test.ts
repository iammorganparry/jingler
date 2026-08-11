import { describe, expect, it } from "vitest"
import {
  BUNDLED_RELEASE_CERTIFICATION_MANIFEST,
  CURRENT_RUNTIME_CONTRACTS
} from "../index.js"

describe("bundled release certification manifest", () => {
  it("is schema-valid and versioned with the shipped runtime contracts", () => {
    expect(BUNDLED_RELEASE_CERTIFICATION_MANIFEST).toMatchObject({
      format: "jingler-release-certification-manifest-v1",
      schemaVersion: 1,
      versions: CURRENT_RUNTIME_CONTRACTS
    })
  })
})
