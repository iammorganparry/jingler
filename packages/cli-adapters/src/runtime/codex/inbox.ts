import type { CodexClient, CodexMessage } from "./client.js"

/** Bounded per-process inbox; thread binding precedes turn/start. */
export class CodexInbox {
  threadId: string | undefined
  private readonly messages: { message: CodexMessage; bytes: number }[] = []
  private bytes = 0
  private error: Error | undefined
  private wake: (() => void) | undefined
  private readonly unsubscribe: (() => void)[]
  constructor(private readonly client: CodexClient) {
    this.unsubscribe = [
      client.onFailure((error) => this.fail(error)),
      client.onMessage((message) => this.push(message))
    ]
  }
  fail(error: Error): void {
    this.error = error
    this.wake?.()
  }
  private push(message: CodexMessage): void {
    if (!this.threadId || message.params.threadId !== this.threadId) {
      if (message.id !== undefined)
        this.client.reject(message.id, "Request does not belong to this run")
      return
    }
    const bytes = Buffer.byteLength(JSON.stringify(message))
    this.bytes += bytes
    if (this.messages.length >= 4096 || this.bytes > 8_388_608) {
      this.fail(new Error("Codex event queue exceeded bound"))
      return
    }
    this.messages.push({ message, bytes })
    this.wake?.()
  }
  async next(): Promise<CodexMessage> {
    while (!this.error) {
      const queued = this.messages.shift()
      if (queued) {
        this.bytes -= queued.bytes
        return queued.message
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve
      })
      this.wake = undefined
    }
    throw this.error
  }
  dispose(): void {
    for (const unsubscribe of this.unsubscribe) unsubscribe()
  }
}
