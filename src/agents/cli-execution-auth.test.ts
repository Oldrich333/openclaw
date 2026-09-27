import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiKeyCredential } from "./auth-profiles/credential-fixtures.test-support.js";
import type { AuthProfileCredential } from "./auth-profiles/types.js";
import { testing as cliBackendsTesting } from "./cli-backends.test-support.js";

const mocks = vi.hoisted(() => ({
  order: [] as string[],
  profiles: {} as Record<string, AuthProfileCredential>,
  orderByProvider: {} as Record<string, { profileIds: string[]; hasExplicitOrder: boolean }>,
  usageStats: {} as Record<
    string,
    {
      blockedUntil?: number;
      cooldownUntil?: number;
      cooldownReason?: "rate_limit";
      cooldownModel?: string;
    }
  >,
}));

vi.mock("./auth-profiles/store-runtime.js", () => ({
  loadAuthProfileStoreForRuntime: () => ({
    version: 1,
    profiles: mocks.profiles,
    usageStats: mocks.usageStats,
  }),
}));

vi.mock("./auth-profiles/order.js", () => ({
  resolveAuthProfileOrderWithMetadata: (params: { provider: string }) =>
    mocks.orderByProvider[params.provider] ?? {
      profileIds: mocks.order,
      hasExplicitOrder: false,
    },
}));

import { resolveCliExecutionAuthProfileId } from "./cli-execution-auth.js";

describe("resolveCliExecutionAuthProfileId", () => {
  beforeEach(() => {
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: () => [
        {
          id: "claude-cli",
          modelProvider: "anthropic",
          pluginId: "anthropic",
          config: { command: "claude" },
        },
        {
          id: "google-gemini-cli",
          modelProvider: "google",
          pluginId: "google-gemini-cli",
          config: { command: "gemini" },
        },
      ],
      resolvePluginSetupCliBackend: () => undefined,
    });
    mocks.order.length = 0;
    for (const provider of Object.keys(mocks.orderByProvider)) {
      delete mocks.orderByProvider[provider];
    }
    for (const profileId of Object.keys(mocks.profiles)) {
      delete mocks.profiles[profileId];
    }
    for (const profileId of Object.keys(mocks.usageStats)) {
      delete mocks.usageStats[profileId];
    }
  });

  afterEach(() => {
    cliBackendsTesting.resetDepsForTest();
  });

  it.each(["auto", "user"] as const)(
    "ignores a retired native Claude profile selected by %s",
    (authProfileIdSource) => {
      const authProfileId = "anthropic:claude-cli";
      mocks.profiles[authProfileId] = {
        type: "oauth",
        provider: "claude-cli",
        access: "retired-access",
        refresh: "retired-refresh",
        expires: Date.now() - 60_000,
      };
      mocks.order.push(authProfileId);

      expect(
        resolveCliExecutionAuthProfileId({
          cliExecutionProvider: "claude-cli",
          authProfileProvider: "claude-cli",
          config: {},
          agentDir: "/tmp/unused-agent",
          ...(authProfileIdSource === "user"
            ? { selected: { authProfileId, authProfileIdSource } }
            : {}),
        }),
      ).toBeUndefined();
    },
  );

  it("keeps forwarding a non-retired Claude profile", () => {
    const authProfileId = "claude-cli:work";
    mocks.profiles[authProfileId] = {
      type: "oauth",
      provider: "claude-cli",
      access: "test-access",
      refresh: "test-refresh",
      expires: Date.now() + 60_000,
    };

    expect(
      resolveCliExecutionAuthProfileId({
        cliExecutionProvider: "claude-cli",
        authProfileProvider: "claude-cli",
        config: {},
        agentDir: "/tmp/unused-agent",
        selected: { authProfileId, authProfileIdSource: "user" },
      }),
    ).toBe(authProfileId);
  });

  it.each([
    { type: "api_key", registry: "runtime" },
    { type: "token", registry: "runtime" },
    { type: "oauth", registry: "runtime" },
    { type: "token", registry: "setup" },
  ] as const)(
    "forwards an explicitly selected canonical Anthropic $type through the $registry registry",
    ({ type, registry }) => {
      if (registry === "setup") {
        cliBackendsTesting.setDepsForTest({
          resolveRuntimeCliBackends: () => [],
          resolvePluginSetupCliBackend: ({ backend }) =>
            backend === "claude-cli"
              ? {
                  pluginId: "anthropic",
                  backend: {
                    id: "claude-cli",
                    modelProvider: "anthropic",
                    config: { command: "claude" },
                  },
                }
              : undefined,
        });
      }
      const authProfileId = `anthropic:managed-${type}`;
      mocks.profiles[authProfileId] =
        type === "api_key"
          ? { type, provider: "anthropic", key: "test-anthropic-key" }
          : type === "token"
            ? { type, provider: "anthropic", token: "test-anthropic-token" }
            : {
                type,
                provider: "anthropic",
                access: "test-anthropic-access",
                refresh: "test-anthropic-refresh",
                expires: Date.now() + 60_000,
              };

      expect(
        resolveCliExecutionAuthProfileId({
          cliExecutionProvider: "claude-cli",
          authProfileProvider: "anthropic",
          config: {},
          agentDir: "/tmp/unused-agent",
          selected: { authProfileId, authProfileIdSource: "user" },
        }),
      ).toBe(authProfileId);
    },
  );

  it("loads the selected personal profile without falling back to an ambient Claude account", () => {
    const authProfileId =
      "personal:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222";
    const credential: AuthProfileCredential = {
      type: "token",
      provider: "anthropic",
      token: "test-personal-anthropic-token",
    };
    mocks.profiles["claude-cli:ambient"] = createApiKeyCredential("claude-cli", "test-ambient-key");
    mocks.order.push("claude-cli:ambient");

    expect(
      resolveCliExecutionAuthProfileId({
        cliExecutionProvider: "claude-cli",
        authProfileProvider: "anthropic",
        config: {},
        agentDir: "/tmp/unused-agent",
        selected: { authProfileId, authProfileIdSource: "user" },
        loadAuthProfileStoreForRuntime: (_agentDir, options) => ({
          version: 1,
          profiles: {
            ...mocks.profiles,
            ...(options?.profileId === authProfileId ? { [authProfileId]: credential } : {}),
          },
        }),
      }),
    ).toBe(authProfileId);
  });

  it.each(["absent", "auto"] as const)(
    "forwards only automatic Claude profiles owned by Claude CLI (%s selection)",
    (selection) => {
      const selected =
        selection === "auto"
          ? { authProfileId: "anthropic:default", authProfileIdSource: selection }
          : undefined;
      mocks.profiles["anthropic:default"] = createApiKeyCredential(
        "anthropic",
        "test-anthropic-key",
      );
      mocks.order.push("anthropic:default");

      expect(
        resolveCliExecutionAuthProfileId({
          cliExecutionProvider: "claude-cli",
          authProfileProvider: "anthropic",
          config: {},
          agentDir: "/tmp/unused-agent",
          selected,
        }),
      ).toBeUndefined();

      mocks.profiles["claude-cli:work"] = createApiKeyCredential("claude-cli", "test-claude-key");
      mocks.order.push("claude-cli:work");

      expect(
        resolveCliExecutionAuthProfileId({
          cliExecutionProvider: "claude-cli",
          authProfileProvider: "anthropic",
          config: {},
          agentDir: "/tmp/unused-agent",
          selected,
        }),
      ).toBe("claude-cli:work");
    },
  );

  it.each(["claude-cli", "google-gemini-cli"])(
    "rejects an explicitly selected profile from another provider for %s",
    (cliExecutionProvider) => {
      mocks.profiles["openai:work"] = createApiKeyCredential("openai", "test-openai-key");

      expect(() =>
        resolveCliExecutionAuthProfileId({
          cliExecutionProvider,
          authProfileProvider: "openai",
          config: {},
          agentDir: "/tmp/unused-agent",
          selected: {
            authProfileId: "openai:work",
            authProfileIdSource: "user",
          },
        }),
      ).toThrow(/cannot use auth profile "openai:work"/);
    },
  );

  it("rejects a missing explicitly selected profile instead of changing identities", () => {
    expect(() =>
      resolveCliExecutionAuthProfileId({
        cliExecutionProvider: "google-gemini-cli",
        authProfileProvider: "google-gemini-cli",
        config: {},
        agentDir: "/tmp/unused-agent",
        selected: {
          authProfileId: "google-gemini-cli:missing",
          authProfileIdSource: "user",
        },
      }),
    ).toThrow(/No credentials found for profile "google-gemini-cli:missing"/);
  });

  it("bridges only a stored canonical Google API key to Gemini CLI", () => {
    mocks.profiles["google:work"] = createApiKeyCredential("google", "test-google-key");

    expect(
      resolveCliExecutionAuthProfileId({
        cliExecutionProvider: "google-gemini-cli",
        authProfileProvider: "google",
        config: {},
        agentDir: "/tmp/unused-agent",
        selected: {
          authProfileId: "google:work",
          authProfileIdSource: "user",
        },
      }),
    ).toBe("google:work");

    mocks.profiles["google:work"] = {
      type: "oauth",
      provider: "google",
      access: "test-access",
      refresh: "test-refresh",
      expires: Date.now() + 60_000,
    };
    expect(() =>
      resolveCliExecutionAuthProfileId({
        cliExecutionProvider: "google-gemini-cli",
        authProfileProvider: "google",
        config: {},
        agentDir: "/tmp/unused-agent",
        selected: {
          authProfileId: "google:work",
          authProfileIdSource: "user",
        },
      }),
    ).toThrow(/cannot use auth profile "google:work"/);
  });

  it("requires a Gemini-native selected profile to be owned by Gemini CLI", () => {
    mocks.profiles["google-gemini-cli:work"] = createApiKeyCredential(
      "openai",
      "test-wrong-provider-key",
    );
    const resolve = () =>
      resolveCliExecutionAuthProfileId({
        cliExecutionProvider: "google-gemini-cli",
        authProfileProvider: "google-gemini-cli",
        config: {},
        agentDir: "/tmp/unused-agent",
        selected: {
          authProfileId: "google-gemini-cli:work",
          authProfileIdSource: "user",
        },
      });

    expect(resolve).toThrow(/cannot use auth profile "google-gemini-cli:work"/);

    mocks.profiles["google-gemini-cli:work"] = {
      type: "oauth",
      provider: "google-gemini-cli",
      access: "test-access",
      refresh: "test-refresh",
      expires: Date.now() + 60_000,
    };
    expect(resolve()).toBe("google-gemini-cli:work");
  });

  it("uses the stored owner for a Gemini-native model profile", () => {
    mocks.profiles["google-gemini-cli:alice"] = {
      type: "oauth",
      provider: "google-gemini-cli",
      access: "test-access",
      refresh: "test-refresh",
      expires: Date.now() + 60_000,
    };

    expect(
      resolveCliExecutionAuthProfileId({
        cliExecutionProvider: "google-gemini-cli",
        authProfileProvider: "google",
        config: {},
        agentDir: "/tmp/unused-agent",
        selected: {
          authProfileId: "google-gemini-cli:alice",
          authProfileIdSource: "user",
        },
      }),
    ).toBe("google-gemini-cli:alice");
  });

  describe("bound session on an unusable profile", () => {
    const bound = "anthropic:max";
    const spare = "anthropic:team";
    const groups = [[bound, spare]];
    const resolveBound = (params: {
      historyEquivalenceGroups?: string[][];
      selected?: { authProfileId: string; authProfileIdSource: "auto" | "user" };
      modelId?: string;
    }) =>
      resolveCliExecutionAuthProfileId({
        cliExecutionProvider: "claude-cli",
        authProfileProvider: "anthropic",
        config: params.historyEquivalenceGroups
          ? { auth: { historyEquivalenceGroups: params.historyEquivalenceGroups } }
          : {},
        agentDir: "/tmp/unused-agent",
        sessionBinding: { sessionId: "claude-session", authProfileId: bound },
        ...(params.selected ? { selected: params.selected } : {}),
        ...(params.modelId ? { modelId: params.modelId } : {}),
      });

    beforeEach(() => {
      for (const profileId of [bound, spare]) {
        mocks.profiles[profileId] = {
          type: "token",
          provider: "anthropic",
          token: `test-${profileId}`,
        };
      }
      mocks.order.push(bound, spare);
      mocks.usageStats[bound] = { blockedUntil: Date.now() + 60 * 60_000 };
    });

    it("moves to a usable operator-equivalent profile", () => {
      expect(resolveBound({ historyEquivalenceGroups: groups })).toBe(spare);
    });

    it("keeps the bound profile when no equivalence group is configured", () => {
      expect(resolveBound({})).toBe(bound);
    });

    it("keeps the bound profile when the usable profile shares no group with it", () => {
      expect(resolveBound({ historyEquivalenceGroups: [[spare, "anthropic:other"]] })).toBe(bound);
    });

    it("keeps the bound profile when every equivalent profile is unusable too", () => {
      mocks.usageStats[spare] = { cooldownUntil: Date.now() + 60_000 };
      expect(resolveBound({ historyEquivalenceGroups: groups })).toBe(bound);
    });

    it("keeps a usable bound profile even when an equivalent one exists", () => {
      delete mocks.usageStats[bound];
      expect(resolveBound({ historyEquivalenceGroups: groups })).toBe(bound);
    });

    it("stops at an explicit CLI order that holds no equivalent profile", () => {
      mocks.orderByProvider["claude-cli"] = { profileIds: [], hasExplicitOrder: true };
      expect(resolveBound({ historyEquivalenceGroups: groups })).toBe(bound);
    });

    it("keeps the bound profile when its cooldown belongs to another model", () => {
      mocks.usageStats[bound] = {
        cooldownUntil: Date.now() + 60 * 60_000,
        cooldownReason: "rate_limit",
        cooldownModel: "claude-opus-4-7",
      };
      expect(resolveBound({ historyEquivalenceGroups: groups, modelId: "claude-sonnet-5" })).toBe(
        bound,
      );
      expect(resolveBound({ historyEquivalenceGroups: groups, modelId: "claude-opus-4-7" })).toBe(
        spare,
      );
    });

    it("uses an equivalent profile whose cooldown belongs to another model", () => {
      mocks.usageStats[spare] = {
        cooldownUntil: Date.now() + 60 * 60_000,
        cooldownReason: "rate_limit",
        cooldownModel: "claude-opus-4-7",
      };
      expect(resolveBound({ historyEquivalenceGroups: groups, modelId: "claude-sonnet-5" })).toBe(
        spare,
      );
      expect(resolveBound({ historyEquivalenceGroups: groups, modelId: "claude-opus-4-7" })).toBe(
        bound,
      );
    });

    it("never moves an explicit user selection", () => {
      expect(
        resolveBound({
          historyEquivalenceGroups: groups,
          selected: { authProfileId: bound, authProfileIdSource: "user" },
        }),
      ).toBe(bound);
    });
  });
});
