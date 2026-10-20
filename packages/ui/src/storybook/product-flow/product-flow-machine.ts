import type { AuthKind } from "@jingler/core"
import { assign, setup } from "xstate"

export type ProductFlowCheckpoint =
  | "auth"
  | "workspace"
  | "github"
  | "provider"
  | "app"

interface ProductFlowContext {
  readonly startAt: ProductFlowCheckpoint
  readonly workspaceChosen: boolean
  readonly githubConnected: boolean
  readonly providerConnected: boolean
  readonly providerPendingAuthKind: AuthKind | null
}

type ProductFlowEvent =
  | { readonly type: "AUTHENTICATE" }
  | { readonly type: "CHOOSE_WORKSPACE" }
  | { readonly type: "CONTINUE" }
  | { readonly type: "CONNECT_GITHUB" }
  | { readonly type: "SKIP_GITHUB" }
  | { readonly type: "CONNECT_PROVIDER"; readonly authKind: AuthKind }
  | { readonly type: "PROVIDER_CONNECTED" }
  | { readonly type: "SKIP_PROVIDER" }
  | { readonly type: "RESET" }

export const productFlowMachine = setup({
  types: {
    context: {} as ProductFlowContext,
    events: {} as ProductFlowEvent,
    input: {} as { readonly startAt: ProductFlowCheckpoint }
  },
  guards: {
    startsAtAuth: ({ context }) => context.startAt === "auth",
    startsAtWorkspace: ({ context }) => context.startAt === "workspace",
    startsAtGithub: ({ context }) => context.startAt === "github",
    startsAtProvider: ({ context }) => context.startAt === "provider",
    workspaceIsChosen: ({ context }) => context.workspaceChosen,
    providerIsConnected: ({ context }) => context.providerConnected
  },
  actions: {
    chooseWorkspace: assign({ workspaceChosen: true }),
    connectGithub: assign({ githubConnected: true }),
    beginProviderConnection: assign(({ event }) => ({
      providerPendingAuthKind:
        event.type === "CONNECT_PROVIDER" ? event.authKind : null
    })),
    connectProvider: assign({
      providerConnected: true,
      providerPendingAuthKind: null
    })
  }
}).createMachine({
  id: "storybookProductFlow",
  initial: "route",
  context: ({ input }) => ({
    startAt: input.startAt,
    workspaceChosen: input.startAt !== "auth" && input.startAt !== "workspace",
    githubConnected: input.startAt === "provider" || input.startAt === "app",
    providerConnected: input.startAt === "app",
    providerPendingAuthKind: null
  }),
  states: {
    route: {
      always: [
        { guard: "startsAtAuth", target: "auth" },
        { guard: "startsAtWorkspace", target: "workspace" },
        { guard: "startsAtGithub", target: "github" },
        { guard: "startsAtProvider", target: "provider" },
        { target: "app" }
      ]
    },
    auth: {
      on: { AUTHENTICATE: "workspace" }
    },
    workspace: {
      on: {
        CHOOSE_WORKSPACE: { actions: "chooseWorkspace" },
        CONTINUE: { guard: "workspaceIsChosen", target: "github" }
      }
    },
    github: {
      on: {
        CONNECT_GITHUB: { target: "provider", actions: "connectGithub" },
        SKIP_GITHUB: "provider"
      }
    },
    provider: {
      on: {
        CONNECT_PROVIDER: {
          target: "providerConnecting",
          actions: "beginProviderConnection"
        },
        CONTINUE: { guard: "providerIsConnected", target: "app" },
        SKIP_PROVIDER: "app"
      }
    },
    providerConnecting: {
      after: { 900: { target: "provider", actions: "connectProvider" } },
      on: {
        PROVIDER_CONNECTED: { target: "provider", actions: "connectProvider" }
      }
    },
    app: {
      on: { RESET: "auth" }
    }
  }
})
