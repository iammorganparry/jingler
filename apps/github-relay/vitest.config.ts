import { cloudflareTest } from "@cloudflare/vitest-pool-workers"
import { defineConfig } from "vitest/config"

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
          GITHUB_RELAY_SIGNING_SECRET: "test-relay-signing-secret"
        }
      }
    })
  ],
  test: {
    name: "github-relay",
    include: ["src/**/*.test.ts"]
  }
})
