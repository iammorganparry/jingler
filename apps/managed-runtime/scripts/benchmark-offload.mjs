const origin = process.env.MANAGED_RUNTIME_ORIGIN ?? "https://managed-runtime.jingler.dev"
const secret = process.env.MANAGED_RUNTIME_SERVICE_SECRET
const samples = Number.parseInt(process.env.OFFLOAD_BENCHMARK_SAMPLES ?? "20", 10)

if (!(secret && secret.length >= 32)) {
  throw new Error("MANAGED_RUNTIME_SERVICE_SECRET must contain at least 32 characters")
}
if (!(Number.isSafeInteger(samples) && samples >= 1 && samples <= 100)) {
  throw new Error("OFFLOAD_BENCHMARK_SAMPLES must be between 1 and 100")
}
const target = new URL("/v1/offload-benchmark", origin)
if (target.protocol !== "https:" && target.hostname !== "127.0.0.1" && target.hostname !== "localhost") {
  throw new Error("Offload benchmark requires HTTPS or a loopback endpoint")
}

const cold = []
const warm = []
for (let index = 0; index < samples; index += 1) {
  const response = await fetch(target, {
    method: "POST",
    headers: { "x-jingler-service-secret": secret }
  })
  if (!response.ok) throw new Error(`Benchmark sample ${index + 1} failed with HTTP ${response.status}`)
  const value = await response.json()
  if (
    value?.success !== true ||
    !Number.isSafeInteger(value.coldMs) ||
    !Number.isSafeInteger(value.warmMs)
  ) {
    throw new Error(`Benchmark sample ${index + 1} returned invalid timings`)
  }
  cold.push(value.coldMs)
  warm.push(value.warmMs)
}

const percentile95 = (values) =>
  [...values].sort((left, right) => left - right)[Math.ceil(values.length * 0.95) - 1]
const result = {
  samples,
  coldP95Ms: percentile95(cold),
  warmP95Ms: percentile95(warm),
  targets: { coldP95Ms: 20_000, warmP95Ms: 5_000 },
  passed: percentile95(cold) < 20_000 && percentile95(warm) < 5_000
}
console.log(JSON.stringify(result, null, 2))
if (!result.passed) process.exitCode = 1
