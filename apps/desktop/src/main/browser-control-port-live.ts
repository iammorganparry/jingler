/**
 * The desktop implementation of `BrowserControlPort` (the interface lives in
 * `@jingler/cli-adapters`). It binds the agent-facing browser tools to the real
 * embedded browser by running each `PreviewViewService` op as a Promise.
 *
 * Split from the port definition on purpose: only this file imports Electron
 * (transitively, via `PreviewViewService`), so `cli-adapters` — which builds the
 * MCP server against the interface — never pulls the main bundle in.
 */
import { BrowserControlPort } from "@jingler/cli-adapters"
import { Effect, Layer } from "effect"
import { PreviewViewService } from "./preview-view.js"

export const BrowserControlPortLive = Layer.effect(
  BrowserControlPort,
  Effect.gen(function* () {
    const preview = yield* PreviewViewService
    // Each op has `R = never` once `preview` is captured, so `runPromise` is
    // safe; it rejects with the `BrowserControlError` the op fails with, which
    // the MCP tool handler surfaces to the model.
    return BrowserControlPort.of({
      forSession: (sessionId) => ({
        navigate: (url) => Effect.runPromise(preview.controlNavigate(sessionId, url)),
        screenshot: () => Effect.runPromise(preview.controlScreenshot(sessionId)),
        click: (selector) => Effect.runPromise(preview.controlClick(sessionId, selector)),
        type: (selector, text) =>
          Effect.runPromise(preview.controlType(sessionId, selector, text)),
        readText: () => Effect.runPromise(preview.controlReadText(sessionId)),
        evaluate: (expression) =>
          Effect.runPromise(preview.controlEvaluate(sessionId, expression)),
        waitForSelector: (selector, timeoutMs) =>
          Effect.runPromise(preview.controlWaitForSelector(sessionId, selector, timeoutMs))
      })
    })
  })
)
