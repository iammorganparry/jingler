import type { EvalObservation } from "../behavior-contract.js"

export type FakePiStep =
  | { readonly kind: "observation"; readonly value: EvalObservation }
  | { readonly kind: "invalid-tool-arguments"; readonly tool: string }
  | { readonly kind: "failure"; readonly message: string }
  | { readonly kind: "wait-for-abort" }

/** Scriptable model transport fixture. Pi adapters consume its steps; no network API exists. */
export class FakePiProvider {
  readonly #steps: ReadonlyArray<FakePiStep>
  readonly #observations: Array<EvalObservation> = []
  #cursor = 0

  constructor(steps: ReadonlyArray<FakePiStep>) {
    this.#steps = steps
  }

  get observations(): ReadonlyArray<EvalObservation> {
    return this.#observations
  }

  async next(signal?: AbortSignal): Promise<FakePiStep | null> {
    const step = this.#steps[this.#cursor] ?? null
    if (step === null) return null
    this.#cursor += 1
    if (step.kind === "failure") throw new Error(step.message)
    if (step.kind === "wait-for-abort") {
      if (signal?.aborted) return step
      await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }))
      return step
    }
    if (step.kind === "observation") this.#observations.push(step.value)
    return step
  }
}
