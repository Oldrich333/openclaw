import { validateModelsAuthRefreshParams } from "../../../packages/gateway-protocol/src/index.js";
import { tryResolveAmbientOwnerAgentId } from "../../agents/agent-scope-config.js";
import { reloadSharedAuthStoreOwnership } from "../../agents/auth-profiles/path-resolve.js";
import { noteRuntimeAuthProfileStorePersistedMutation } from "../../agents/auth-profiles/runtime-snapshots.js";
import { prepareModelRuntimeSnapshot } from "../../agents/prepared-model-runtime.js";
import { refreshActiveProviderAuthRuntimeSnapshot } from "../../secrets/runtime.js";
import { modelAuthAgentScopeError, resolveModelAuthAgentScope } from "./model-auth-agent-scope.js";
import { clearModelAuthStatusUsageCache } from "./models-auth-status-usage-cache.js";
import { respondUnavailableOnThrow } from "./response.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export async function refreshModelAuthStateAfterMutation(
  context: Pick<GatewayRequestContext, "getRuntimeConfig" | "reconcileConfigAfterExternalWrite">,
  operation: "login" | "logout" | "update",
  agentId: string,
): Promise<void> {
  // The first CLI login can move the shared store after this Gateway pinned its owner.
  reloadSharedAuthStoreOwnership();
  clearModelAuthStatusUsageCache();
  const initialConfig = context.getRuntimeConfig();
  const scope = resolveModelAuthAgentScope(initialConfig, agentId);
  if (!scope.ok) {
    throw new Error(modelAuthAgentScopeError(scope).message);
  }
  // External CLI writes and native login do not emit an in-process store event.
  // The existing publication owner coalesces this with local mutation events.
  noteRuntimeAuthProfileStorePersistedMutation(scope.agentDir, {
    credentialsChanged: true,
    profileSetChanged: operation !== "update",
    stateChanged: false,
    profileIds: [],
  });
  const application = await context.reconcileConfigAfterExternalWrite();
  if (application !== "applied") {
    const nextStep =
      application === "restart-pending"
        ? "Complete the pending Gateway restart before retrying."
        : "Retry when configuration application is ready.";
    throw new Error(
      `Gateway configuration application is ${application}; model authentication refresh is incomplete. ${nextStep}`,
    );
  }
  const readCurrentConfig = () => {
    const config = context.getRuntimeConfig();
    const currentScope = resolveModelAuthAgentScope(config, agentId);
    if (!currentScope.ok) {
      throw new Error(modelAuthAgentScopeError(currentScope).message);
    }
    if (currentScope.agentId !== scope.agentId || currentScope.agentDir !== scope.agentDir) {
      throw new Error(
        "Agent authentication scope changed while applying configuration. Retry for the current agent.",
      );
    }
    return config;
  };
  readCurrentConfig();
  await refreshActiveProviderAuthRuntimeSnapshot();
  const config = readCurrentConfig();
  await prepareModelRuntimeSnapshot({ config, agentId, agentDir: scope.agentDir });
  readCurrentConfig();
}

export const modelsAuthRefreshHandlers: GatewayRequestHandlers = {
  "models.authRefresh": async ({ params, respond, context }) => {
    if (
      !assertValidParams(params, validateModelsAuthRefreshParams, "models.authRefresh", respond)
    ) {
      return;
    }
    const config = context.getRuntimeConfig();
    const scope = resolveModelAuthAgentScope(
      config,
      params.agentId === undefined || params.agentId === ""
        ? tryResolveAmbientOwnerAgentId(config)
        : params.agentId,
    );
    if (!scope.ok) {
      respond(false, undefined, modelAuthAgentScopeError(scope));
      return;
    }
    await respondUnavailableOnThrow(respond, async () => {
      await refreshModelAuthStateAfterMutation(context, params.operation, scope.agentId);
      respond(true, { refreshed: true }, undefined);
    });
  },
};
