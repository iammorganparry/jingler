import { describe, expect, it } from "vitest"
import {
  auditDesktopArchive,
  auditDeviceBundle,
  auditRuntimeDependencies
} from "./package-artifact-policy.mjs"

const piBundle = [
  "node_modules/@earendil-works/pi-ai/dist/index.js",
  "node_modules/@earendil-works/pi-coding-agent/dist/index.js",
  "jingler-release-certification-manifest-v1",
  "MIT License",
  "Copyright (c) 2025 Mario Zechner"
].join("\n")

describe("package artifact policy", () => {
  it("accepts pi-only desktop and device runtime artifacts", () => {
    expect(auditDeviceBundle(piBundle)).toEqual([])
    expect(auditDesktopArchive([
      "/node_modules/@earendil-works/pi-ai/package.json",
      "/node_modules/@earendil-works/pi-coding-agent/package.json",
      "/node_modules/pi-subagents/package.json"
    ])).toEqual([])
  })

  it("rejects deleted harness SDKs and plaintext pi auth files", () => {
    expect(auditDeviceBundle(`${piBundle}\nnode_modules/@openai/codex-sdk/index.js`))
      .toContain("device bundle contains @openai/codex-sdk")
    expect(auditDesktopArchive([
      "/node_modules/@earendil-works/pi-ai/package.json",
      "/node_modules/@earendil-works/pi-coding-agent/package.json",
      "/node_modules/@anthropic-ai/claude-agent-sdk/package.json",
      "/.pi/agent/auth.json"
    ])).toEqual(expect.arrayContaining([
      "desktop archive contains @anthropic-ai/claude-agent-sdk",
      "desktop archive contains plaintext credential file .pi/agent/auth.json"
    ]))
  })

  it("requires pi and forbids legacy SDKs in runtime manifests", () => {
    expect(auditRuntimeDependencies({ dependencies: {
      "@earendil-works/pi-ai": "0.84.1",
      "@earendil-works/pi-coding-agent": "0.84.1",
      "pi-subagents": "0.49.0"
    } }, "desktop")).toEqual([])
    expect(auditRuntimeDependencies({ dependencies: {
      "@anthropic-ai/claude-agent-sdk": "1.0.0"
    } }, "desktop")).toEqual(expect.arrayContaining([
      "desktop does not declare @earendil-works/pi-ai",
      "desktop declares legacy dependency @anthropic-ai/claude-agent-sdk"
    ]))
  })
})
