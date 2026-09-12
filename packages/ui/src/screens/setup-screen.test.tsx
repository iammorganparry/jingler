/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  ProviderCatalog,
  ResourceDetectionResult,
  type GitHubConnection,
  type ProviderConnectionId,
} from "@jingler/core";
import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SetupScreen, type SetupScreenProps } from "./setup-screen.js";

afterEach(cleanup);

const github: GitHubConnection = {
  mode: "disconnected",
  enabled: true,
  connected: false,
  user: null,
  installations: [],
  lastRefreshedAt: null,
  error: null,
};

const authenticatedCatalog = Schema.decodeSync(ProviderCatalog)({
  connections: [
    {
      connection: {
        id: "connection-1",
        providerId: "anthropic",
        authKind: "claude-setup-token",
        account: null,
        targetId: "desktop",
        status: "authenticated",
        subscription: {
          entitlement: "active",
          planLabel: "Max",
          expiresAt: null,
          quotaLabel: null,
          rateLimitLabel: null,
          confirmedBillingRoute: "subscription",
        },
        createdAt: "2026-08-12T08:00:00.000Z",
        updatedAt: "2026-08-12T08:00:00.000Z",
      },
      models: [],
    },
  ],
  refreshedAt: "2026-08-12T08:00:00.000Z",
  stale: false,
});

const unconfirmedConnection = (id: string) => ({
  connection: {
    id,
    providerId: "anthropic",
    authKind: "claude-setup-token" as const,
    account: { fingerprint: "02061a04ef6f", displayLabel: null },
    targetId: "desktop",
    status: "entitlement-unconfirmed" as const,
    subscription: {
      entitlement: "requires-api-credits" as const,
      planLabel: null,
      expiresAt: null,
      quotaLabel: null,
      rateLimitLabel: null,
      confirmedBillingRoute: "api" as const,
      observedRoute:
        "anthropic:anthropic-messages:https://api.anthropic.com:http-200",
    },
    createdAt: "2026-08-14T09:29:46.674Z",
    updatedAt: "2026-08-14T09:29:46.674Z",
  },
  models: [],
});

const unconfirmedCatalog = Schema.decodeSync(ProviderCatalog)({
  connections: [
    unconfirmedConnection("connection-1"),
    unconfirmedConnection("connection-2"),
  ],
  refreshedAt: "2026-08-14T09:30:00.000Z",
  stale: false,
});

const detectedResources = Schema.decodeSync(ResourceDetectionResult)({
  candidates: [
    {
      id: "deploy",
      kind: "skill",
      name: "Deploy",
      description: "Deploy the application.",
      byteLength: 42,
      provenance: {
        origin: "shared",
        sourceRoot: "/resources",
        sourcePath: "/resources/deploy/SKILL.md",
        importedAt: null,
      },
    },
    {
      id: "review",
      kind: "prompt",
      name: "Review",
      description: "Review current changes.",
      byteLength: 37,
      provenance: {
        origin: "claude",
        sourceRoot: "/prompts",
        sourcePath: "/prompts/review.md",
        importedAt: null,
      },
    },
  ],
  skipped: [],
});

const props = (
  overrides: Partial<SetupScreenProps> = {},
): SetupScreenProps => ({
  step: "workspace",
  github,
  onChooseDir: vi.fn(),
  onContinue: vi.fn(),
  onConnectGithub: vi.fn(),
  onSkipGithub: vi.fn(),
  onConnectClaude: vi.fn(),
  onStartCodex: vi.fn(),
  onConnectApi: vi.fn(),
  onContinueProvider: vi.fn(),
  onSkipProvider: vi.fn(),
  onCancelAuth: vi.fn(),
  onRetryProvider: vi.fn(),
  onImportResources: vi.fn(),
  onSkipResources: vi.fn(),
  onCancelResourceImport: vi.fn(),
  onRetryResources: vi.fn(),
  ...overrides,
});

describe("SetupScreen", () => {
  it("does not present a provider harness picker", () => {
    render(<SetupScreen {...props()} />);
    expect(screen.queryByText("HARNESSES")).toBeNull();
    expect(screen.queryByText(/Claude Code|Codex CLI|opencode/u)).toBeNull();
  });

  it("connects the authenticated Claude CLI without collecting credentials", () => {
    const onConnectClaude = vi.fn();
    render(<SetupScreen {...props({ step: "provider", onConnectClaude })} />);
    fireEvent.click(screen.getByRole("button", { name: "Use Claude CLI" }));

    expect(onConnectClaude).toHaveBeenCalledWith("claude-cli");
    expect(screen.queryByPlaceholderText("Claude setup-token")).toBeNull();
  });

  it("submits an API key for the selected BeUI provider", () => {
    const onConnectApi = vi.fn();
    render(<SetupScreen {...props({ step: "provider", onConnectApi })} />);
    fireEvent.click(screen.getByText("Use an API key instead"));
    fireEvent.click(screen.getByRole("button", { name: "API provider" }));
    fireEvent.click(screen.getByRole("option", { name: "Google API" }));
    fireEvent.change(screen.getByPlaceholderText("Provider API key"), {
      target: { value: "test-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save API key" }));
    expect(onConnectApi).toHaveBeenCalledWith("google", "test-key");
  });

  it("offers browser and device-code Codex subscription login", () => {
    const onStartCodex = vi.fn();
    render(<SetupScreen {...props({ step: "provider", onStartCodex })} />);
    fireEvent.click(screen.getByRole("button", { name: "Open browser" }));
    fireEvent.click(screen.getByRole("button", { name: "Use device code" }));
    expect(onStartCodex).toHaveBeenNthCalledWith(1, "browser");
    expect(onStartCodex).toHaveBeenNthCalledWith(2, "device-code");
  });

  it("continues after authentication without requiring model selection", () => {
    const onContinueProvider = vi.fn();
    render(
      <SetupScreen
        {...props({
          step: "provider",
          providerCatalog: authenticatedCatalog,
          onContinueProvider,
        })}
      />,
    );

    expect(screen.queryByRole("button", { name: "Verify model" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onContinueProvider).toHaveBeenCalledOnce();
  });

  it("collapses credential forms after connection and can add another account", () => {
    render(
      <SetupScreen
        {...props({
          step: "provider",
          providerCatalog: authenticatedCatalog,
        })}
      />,
    );

    const accountDetails = screen
      .getByRole("button", { name: "Use Claude CLI" })
      .closest("details");
    expect(accountDetails?.open).toBe(false);
    fireEvent.click(screen.getByText("Add another account"));
    expect(accountDetails?.open).toBe(true);
    expect(screen.getByRole("button", { name: "Open browser" })).toBeTruthy();
  });

  it("shows the provider-specific connecting state", () => {
    render(
      <SetupScreen
        {...props({
          step: "provider",
          busy: true,
          providerPendingAuthKind: "openai-codex-oauth",
        })}
      />,
    );

    expect(screen.getByText("Connecting Codex…", { selector: "button" })).toBeTruthy();
    expect(screen.getByText("Connecting Codex…", { selector: "span" })).toBeTruthy();
  });

  it("keeps Continue disabled without auth and exposes Skip for now", () => {
    const onSkipProvider = vi.fn();
    render(<SetupScreen {...props({ step: "provider", onSkipProvider })} />);

    expect(
      (screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(onSkipProvider).toHaveBeenCalledOnce();
  });

  it("surfaces unconfirmed entitlement once per account instead of hiding it", () => {
    render(
      <SetupScreen
        {...props({ step: "provider", providerCatalog: unconfirmedCatalog })}
      />,
    );

    expect(
      screen.getAllByText("Claude CLI subscription needs attention"),
    ).toHaveLength(1);
    expect(screen.getByText(/billed as API credits/u)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Use Claude CLI" })).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("presents a device code without exposing OAuth credentials", () => {
    render(
      <SetupScreen
        {...props({
          step: "provider",
          busy: true,
          providerLoginEvent: {
            type: "device-code",
            connectionId: "codex-1" as ProviderConnectionId,
            userCode: "ABCD-EFGH",
            verificationUri: "https://example.test/device",
            expiresInSeconds: 600,
          },
        })}
      />,
    );
    expect(screen.getByText("ABCD-EFGH")).toBeTruthy();
    expect(screen.getByText("https://example.test/device")).toBeTruthy();
  });

  it("imports every detected resource with one action", () => {
    const onImportResources = vi.fn();
    render(
      <SetupScreen
        {...props({
          step: "resources",
          resourceDetection: detectedResources,
          onImportResources,
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Import all" }));
    expect(onImportResources).toHaveBeenCalledWith(
      detectedResources.candidates,
    );
  });

  it("searches resources without discarding hidden selections", () => {
    const onImportResources = vi.fn();
    render(
      <SetupScreen
        {...props({
          step: "resources",
          resourceDetection: detectedResources,
          onImportResources,
        })}
      />,
    );

    fireEvent.change(screen.getByRole("searchbox", { name: "Search agent resources" }), {
      target: { value: "review" },
    });
    expect(screen.queryByText("Deploy", { exact: true })).toBeNull();
    expect(screen.getByText("Review", { exact: true })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Import selected" }));
    expect(onImportResources).toHaveBeenCalledWith(detectedResources.candidates);
  });
});
