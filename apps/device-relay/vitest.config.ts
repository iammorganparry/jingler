import { cloudflareTest } from "@cloudflare/vitest-pool-workers"
import { defineConfig } from "vitest/config"

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          DEVICE_RELAY_SIGNING_SECRET: "test-device-relay-signing-secret-at-least-32-bytes"
        }
      }
    })
  ],
  test: {
    name: "device-relay",
    include: ["src/**/*.test.ts"]
  }
})
