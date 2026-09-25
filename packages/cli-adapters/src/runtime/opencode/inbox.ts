import { eventSessionId, normalizeOpenCodeEvent } from "./events.js"
import type { Event } from "@opencode-ai/sdk/v2/client"
import type { OpenCodeServer } from "./server.js"

/** The SDK owns decoding; the server wrapper bounds bytes before that decoder. */
export class OpenCodeInbox {
  private readonly queue: Event[] = []
  private bytes = 0
  private wake?: () => void
  private failure?: Error
  private readonly abort = new AbortController()
  private readonly ready: Promise<void>
  private connected!: () => void
  constructor(server: OpenCodeServer, directory: string, sessionID: string) {
    this.ready = new Promise((resolve) => { this.connected = resolve })
    void this.read(server, directory, sessionID)
  }
  private async read(server: OpenCodeServer, directory: string, sessionID: string) {
    try {
      const subscription = await server.client.global.event({
        signal: AbortSignal.any([this.abort.signal, server.stopped.signal]),
        sseMaxRetryAttempts: 1,
        onSseError: () => this.fail(new Error("OpenCode event stream disconnected"))
      })
      for await (const envelope of subscription.stream) {
        if (envelope.payload.type === "server.connected") this.connected()
        if (envelope.directory !== directory) continue
        const event = normalizeOpenCodeEvent(envelope.payload)
        if (!event) continue
        if (eventSessionId(event) !== sessionID) continue
        const bytes = JSON.stringify(event).length
        if (this.queue.length >= 512 || this.bytes + bytes > 4_194_304) throw new Error("OpenCode event queue exceeded bound")
        this.bytes += bytes
        this.queue.push(event as Event)
        this.wake?.()
      }
      if (!this.abort.signal.aborted) this.fail(new Error("OpenCode event stream ended"))
    } catch { this.fail(new Error("OpenCode event stream failed")) }
  }
  async connectedBeforePrompt() {
    await Promise.race([this.ready, new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error("OpenCode SSE readiness timeout")), 5_000)
      this.ready.finally(() => clearTimeout(timer))
    })])
    if (this.failure) throw this.failure
  }
  fail(error: Error) { this.failure ??= error; this.connected(); this.wake?.() }
  async next(): Promise<Event> {
    while (!this.failure && !this.queue.length) await new Promise<void>((resolve) => { this.wake = resolve })
    if (this.failure) throw this.failure
    const event = this.queue.shift()!
    this.bytes -= JSON.stringify(event).length
    return event
  }
  close() { this.abort.abort(); this.fail(new Error("OpenCode stream closed")) }
}
