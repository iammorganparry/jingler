export type ManagedExecutionLane = "observe" | "mutate"

/** Observation reads never delay turns; workspace mutations remain ordered. */
export class ManagedExecutionScheduler<Command> {
  #mutationTail: Promise<void> = Promise.resolve()

  constructor(private readonly execute: (command: Command) => Promise<void>) {}

  schedule(command: Command, lane: ManagedExecutionLane): Promise<void> {
    if (lane === "observe") return this.execute(command)
    const execution = this.#mutationTail.then(() => this.execute(command))
    this.#mutationTail = execution.catch(() => undefined)
    return execution
  }
}
