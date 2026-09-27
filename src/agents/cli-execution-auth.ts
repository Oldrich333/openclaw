/**
 * Auth-profile forwarding shared by normal and narrow CLI-backed agent runs.
 */
import type { CliSessionBinding } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAuthProfileOrderWithMetadata } from "./auth-profiles/order.js";
import { loadAuthProfileStoreForRuntime } from "./auth-profiles/store-runtime.js";
import type { AuthProfileCredential } from "./auth-profiles/types.js";
import { isProfileInCooldown } from "./auth-profiles/usage-state.js";
import { resolveCliBackendConfig, resolveCliRuntimeCanonicalProvider } from "./cli-backends.js";
import { resolveBundledCliBackendAuthPolicy } from "./cli-runner/cli-backend-auth-policy.js";
import { areOperatorEquivalentProfiles } from "./cli-session.js";

const GOOGLE_GEMINI_CLI_PROVIDER_ID = "google-gemini-cli";
const GOOGLE_PROVIDER_ID = "google";
const CLAUDE_CLI_PROVIDER_ID = "claude-cli";

type CliExecutionAuthProfileSelection = {
  authProfileId?: string;
  authProfileIdSource?: "auto" | "user";
};

class CliExecutionAuthProfileError extends Error {
  override name = "CliExecutionAuthProfileError";
}

export function cliBackendAcceptsAuthProfileForwarding(params: {
  provider: string;
  config: OpenClawConfig;
  agentId?: string;
}): boolean {
  const backend = resolveCliBackendConfig(params.provider, params.config, {
    agentId: params.agentId,
  });
  return backend?.id === GOOGLE_GEMINI_CLI_PROVIDER_ID || backend?.id === CLAUDE_CLI_PROVIDER_ID;
}

/**
 * Preserve the session account unless the user selects another, it was removed,
 * or it is unusable while an operator-equivalent profile is available.
 * A user-locked profile must fail closed rather than run as another user.
 */
export function resolveCliExecutionAuthProfileId(params: {
  cliExecutionProvider: string;
  authProfileProvider: string;
  config: OpenClawConfig;
  agentDir: string;
  selected?: CliExecutionAuthProfileSelection;
  sessionBinding?: CliSessionBinding;
  loadAuthProfileStoreForRuntime?: typeof loadAuthProfileStoreForRuntime;
}): string | undefined {
  const loadStore = params.loadAuthProfileStoreForRuntime ?? loadAuthProfileStoreForRuntime;
  const selectedAuthProfileId = params.selected?.authProfileId?.trim();
  const hasExplicitSelection =
    selectedAuthProfileId && params.selected?.authProfileIdSource !== "auto";
  const sessionAuthProfileId = params.sessionBinding?.authProfileId?.trim();
  const store = loadStore(params.agentDir, {
    readOnly: true,
    allowKeychainPrompt: false,
    externalCliProviderIds: [params.cliExecutionProvider],
    profileId: hasExplicitSelection
      ? selectedAuthProfileId
      : (sessionAuthProfileId ?? selectedAuthProfileId),
  });
  const nativeAuthProfileIds = resolveBundledCliBackendAuthPolicy(
    params.cliExecutionProvider,
  )?.nativeAuthProfileIds;
  if (!hasExplicitSelection && params.sessionBinding && !sessionAuthProfileId) {
    return undefined;
  }
  const retainedProfileId = hasExplicitSelection
    ? selectedAuthProfileId
    : sessionAuthProfileId &&
        (store.profiles[sessionAuthProfileId] ||
          nativeAuthProfileIds?.includes(sessionAuthProfileId))
      ? sessionAuthProfileId
      : undefined;
  const nativeProfileId = retainedProfileId ?? selectedAuthProfileId;
  if (nativeProfileId && nativeAuthProfileIds?.includes(nativeProfileId)) {
    return undefined;
  }
  const canonicalProvider = resolveCliRuntimeCanonicalProvider({
    runtime: params.cliExecutionProvider,
    config: params.config,
    includeSetupRegistry: true,
  });
  const acceptsCredential = (credential: AuthProfileCredential, explicitSelection: boolean) =>
    credential.provider === params.cliExecutionProvider ||
    (credential.provider === canonicalProvider &&
      (params.cliExecutionProvider === CLAUDE_CLI_PROVIDER_ID
        ? explicitSelection || credential.type !== "api_key"
        : params.cliExecutionProvider === GOOGLE_GEMINI_CLI_PROVIDER_ID &&
          credential.type === "api_key"));
  const resolveCandidateProviders = () => {
    const providers = [params.cliExecutionProvider];
    if (
      canonicalProvider &&
      (params.cliExecutionProvider === CLAUDE_CLI_PROVIDER_ID ||
        (params.cliExecutionProvider === GOOGLE_GEMINI_CLI_PROVIDER_ID &&
          params.authProfileProvider === GOOGLE_PROVIDER_ID))
    ) {
      providers.push(canonicalProvider);
    }
    return providers;
  };
  if (retainedProfileId) {
    const credential = store.profiles[retainedProfileId];
    if (!credential) {
      throw new CliExecutionAuthProfileError(
        `No credentials found for profile "${retainedProfileId}".`,
      );
    }
    if (acceptsCredential(credential, true)) {
      if (hasExplicitSelection || !isProfileInCooldown(store, retainedProfileId)) {
        return retainedProfileId;
      }
      // A bound session may move only to a usable profile the operator declared
      // equivalent (`auth.historyEquivalenceGroups`); the native session survives that swap.
      for (const provider of resolveCandidateProviders()) {
        const order = resolveAuthProfileOrderWithMetadata({
          cfg: params.config,
          store,
          provider,
          preferredProfile: selectedAuthProfileId,
        });
        const replacementId = order.profileIds.find((id) => {
          const candidate = store.profiles[id];
          return (
            candidate &&
            acceptsCredential(candidate, false) &&
            !nativeAuthProfileIds?.includes(id) &&
            areOperatorEquivalentProfiles(
              params.config.auth?.historyEquivalenceGroups,
              retainedProfileId,
              id,
            ) &&
            !isProfileInCooldown(store, id)
          );
        });
        if (replacementId) {
          return replacementId;
        }
      }
      return retainedProfileId;
    }
    throw new CliExecutionAuthProfileError(
      `CLI backend "${params.cliExecutionProvider}" cannot use auth profile "${retainedProfileId}" owned by "${credential.provider}".`,
    );
  }

  for (const provider of resolveCandidateProviders()) {
    const order = resolveAuthProfileOrderWithMetadata({
      cfg: params.config,
      store,
      provider,
      preferredProfile: selectedAuthProfileId,
    });
    const profileId = order.profileIds.find((id) => {
      const credential = store.profiles[id];
      return (
        credential && acceptsCredential(credential, false) && !nativeAuthProfileIds?.includes(id)
      );
    });
    if (profileId || order.hasExplicitOrder) {
      return profileId;
    }
  }
  return undefined;
}
