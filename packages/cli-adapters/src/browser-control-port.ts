import { Context } from "effect"

/**
 * The seam between the agent's browser-control MCP (this package) and the main
 * process's embedded browser (`PreviewViewService`, in `apps/desktop`).
 *
 * The MCP tool handlers are plain async functions, so this port speaks Promises
 * rather than Effects: the desktop impl runs each `PreviewViewService` op with
 * `Effect.runPromise` and lets it reject with the underlying `BrowserControlError`.
 * Defined here (not in the desktop app) so `AgentRunner` can build the MCP
 * server against the interface without importing the Electron main bundle.
 */
export interface BrowserControlSessionPortShape {
  /** Open a URL (http/https) in the in-app browser and reveal the dock. */
  readonly navigate: (url: string) => Promise<void>
  /** PNG screenshot of the current page, base64-encoded. */
  readonly screenshot: () => Promise<{ readonly pngBase64: string }>
  /** Click the first element matching a CSS selector. */
  readonly click: (selector: string) => Promise<void>
  /** Type text into the first element matching a CSS selector. */
  readonly type: (selector: string, text: string) => Promise<void>
  /** The page's visible text. */
  readonly readText: () => Promise<{ readonly text: string }>
  /** Evaluate a JS expression in the page; returns its string result. */
  readonly evaluate: (expression: string) => Promise<{ readonly result: string }>
  /** Resolve once a selector appears, or reject after `timeoutMs`. */
  readonly waitForSelector: (selector: string, timeoutMs: number) => Promise<void>
}

export interface BrowserControlPortShape {
  /** Bind every operation to one repository session before it reaches Electron. */
  readonly forSession: (sessionId: string) => BrowserControlSessionPortShape
}

export class BrowserControlPort extends Context.Tag("@jingler/BrowserControlPort")<
  BrowserControlPort,
  BrowserControlPortShape
>() {}
