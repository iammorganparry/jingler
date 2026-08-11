import type { CheckpointManifestStore } from "./workspace-checkpoint.js"

export const r2CheckpointStore = (bucket: R2Bucket): CheckpointManifestStore => ({
  put: async (key, value, size) => {
    if (typeof value === "string") {
      await bucket.put(key, value)
      return
    }
    if (size === undefined || !Number.isSafeInteger(size) || size < 0) {
      throw new Error("Checkpoint archive length is unavailable")
    }
    const fixed = new FixedLengthStream(size)
    await Promise.all([
      value.pipeTo(fixed.writable),
      bucket.put(key, fixed.readable)
    ])
  },
  get: async (key) => (await bucket.get(key))?.body ?? null
})
