import type { StorybookConfig } from "@storybook/react-vite"
import tailwindcss from "@tailwindcss/vite"
import { resolve } from "node:path"
import { mergeConfig } from "vite"

const pierreDiffWorkerEntry = resolve(
  import.meta.dirname,
  "../../../node_modules/@pierre/diffs/dist/worker/worker.js"
)

const config: StorybookConfig = {
  stories: ["../src/**/*.stories.@(ts|tsx)"],
  addons: ["@storybook/addon-a11y", "@storybook/addon-docs"],
  framework: { name: "@storybook/react-vite", options: {} },
  async viteFinal(config) {
    config.plugins = config.plugins ?? []
    config.plugins.push(tailwindcss())
    return mergeConfig(config, {
      resolve: {
        alias: {
          "@jingler/pierre-diffs-worker": pierreDiffWorkerEntry
        }
      },
      worker: { format: "es" }
    })
  }
}

export default config
