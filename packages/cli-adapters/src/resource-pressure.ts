import { cpus, freemem, totalmem } from "node:os"

export interface ResourcePressurePort {
  readonly start: () => void
  readonly isSqueezed: () => boolean
}

interface CpuTotals {
  readonly active: number
  readonly total: number
}

const totals = (): CpuTotals => {
  let active = 0
  let total = 0
  for (const cpu of cpus()) {
    const idle = cpu.times.idle
    const all = Object.values(cpu.times).reduce((sum, value) => sum + value, 0)
    active += all - idle
    total += all
  }
  return { active, total }
}

export const isResourcePressure = (
  cpuSamples: ReadonlyArray<number>,
  freeMemory: number,
  totalMemory: number
): boolean => {
  const memorySqueezed = totalMemory > 0 && freeMemory / totalMemory < 0.2
  const cpuSqueezed = cpuSamples.length >= 10 &&
    cpuSamples.slice(-10).reduce((sum, value) => sum + value, 0) / 10 + Number.EPSILON >= 0.8
  return memorySqueezed || cpuSqueezed
}

/** Rolling host-pressure monitor used by automatic compute routing. */
export const makeResourcePressureMonitor = (): ResourcePressurePort => {
  let previous: CpuTotals | null = null
  let samples: number[] = []
  let started = false

  const sample = (): void => {
    const current = totals()
    if (previous !== null) {
      const elapsed = current.total - previous.total
      if (elapsed > 0) {
        samples = [...samples, (current.active - previous.active) / elapsed].slice(-10)
      }
    }
    previous = current
  }

  return {
    start: () => {
      if (started) return
      started = true
      sample()
      const timer = setInterval(sample, 1_000)
      timer.unref()
    },
    isSqueezed: () => process.env.JINGLER_E2E_RESOURCE_PRESSURE === "1" ||
      isResourcePressure(samples, freemem(), totalmem())
  }
}
