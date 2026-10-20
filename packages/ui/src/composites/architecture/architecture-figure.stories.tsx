import type { Meta, StoryObj } from "@storybook/react-vite"
import { ArchitectureFigure } from "./architecture-figure.js"

const meta: Meta<typeof ArchitectureFigure> = {
  title: "Composites/ArchitectureFigure",
  component: ArchitectureFigure
}
export default meta

export const Checkout: StoryObj<typeof ArchitectureFigure> = {
  args: {
    block: {
      kind: "architecture",
      id: "checkout",
      title: "Checkout request path",
      layers: [{ id: "edge", label: "Edge" }, { id: "app", label: "App" }, { id: "data", label: "Data" }],
      components: [
        { id: "web", label: "web app", layer: "edge", shape: "client" },
        { id: "gw", label: "API gateway", layer: "edge", shape: "gateway" },
        { id: "api", label: "orders-api", layer: "app", shape: "service", detail: "Hono, 3 replicas" },
        { id: "q", label: "order-events", layer: "app", shape: "queue" },
        { id: "mail", label: "mailer", layer: "app", shape: "worker" },
        { id: "db", label: "Postgres", layer: "data", shape: "store" },
        { id: "redis", label: "Redis", layer: "data", shape: "cache" },
        { id: "stripe", label: "Stripe", layer: "data", shape: "external" }
      ],
      links: [
        { from: "web", to: "gw", mode: "sync" },
        { from: "gw", to: "api", label: "POST /orders", mode: "sync" },
        { from: "api", to: "q", label: "publish", mode: "async" },
        { from: "q", to: "mail", mode: "async" },
        { from: "api", to: "db", label: "INSERT", mode: "data" },
        { from: "api", to: "redis", mode: "data" },
        { from: "api", to: "stripe", label: "charge", mode: "sync" }
      ],
      lit: "api"
    }
  }
}
