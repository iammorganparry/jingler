import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth"

// Standalone bundles cannot resolve pi-ai's intentionally opaque relative OAuth imports.
registerBunOAuthFlows()
