import { ModelRuntime } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"
import {
  FakePiProvider,
  fauxAssistantMessage,
  fauxToolCall
} from "./fake-pi-provider.js"

describe("fake pi provider", () => {
  it("installs scripted text and tool responses into a real ModelRuntime", async () => {
    const provider = new FakePiProvider()
    provider.setResponses([
      fauxAssistantMessage(
        fauxToolCall("workspace.read", { path: "README.md" }),
        { stopReason: "toolUse" }
      ),
      fauxAssistantMessage("complete")
    ])
    const runtime = await ModelRuntime.create({
      modelsPath: null,
      refreshOnCreate: false
    })
    provider.install(runtime)

    expect(runtime.getModel(provider.providerId, provider.modelId)).toMatchObject({
      id: provider.modelId,
      provider: provider.providerId
    })
    expect(provider.callCount).toBe(0)
  })
})
