import { expect, test } from "vitest"
import { deriveImportCard } from "./import-card-model.js"

const derive = (machineState: string, error: string | null = null) => deriveImportCard({ machineState, count: 3, error })

test("maps machine states to card states", () => {
  expect(derive("detecting")).toEqual({ kind: "detecting" })
  expect(derive("reviewing")).toEqual({ kind: "found", count: 3 })
  expect(derive("importing")).toEqual({ kind: "found", count: 3 })
  expect(derive("detectFailed", "boom")).toEqual({ kind: "failed", message: "boom" })
  expect(derive("detectFailed")).toEqual({ kind: "failed", message: "Could not detect MCP servers" })
})

test("dismissed, idle, empty and done show no card", () => {
  for (const state of ["idle", "empty", "dismissed", "done"]) expect(derive(state)).toBeNull()
})
