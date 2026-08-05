import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config"

export default defineWorkersConfig({
  test: {
    name: "github-relay",
    include: ["src/**/*.test.ts"],
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
            GITHUB_RELAY_SIGNING_SECRET: "test-relay-signing-secret"
          }
        }
      }
    }
  }
})
