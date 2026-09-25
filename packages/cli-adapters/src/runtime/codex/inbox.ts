import { CodexClient, type CodexMessage } from "./client.js"

/** Bounded per-process inbox; thread binding precedes turn/start. */
export class CodexInbox {
  threadId: string | undefined
  private readonly messages: CodexMessage[] = []
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
    this.bytes += JSON.stringify(message).length
    if (this.messages.length >= 4096 || this.bytes > 8_388_608) {
      this.fail(new Error("Codex event queue exceeded bound"))
      return
    }
    this.messages.push(message)
    this.wake?.()
  }
  async next(): Promise<CodexMessage> {
    while (!this.error) {
      const message = this.messages.shift()
      if (message) {
        this.bytes -= JSON.stringify(message).length
        return message
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
