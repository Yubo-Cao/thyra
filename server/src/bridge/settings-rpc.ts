import type { ServerWebSocket } from "bun";
import {
  CONNECTION_CHANGED_DURING_REQUEST,
  serializeConnectionEnvelope,
} from "../connections/protocol";
import type { HerdrClient } from "./herdr-client";
import { LEGACY_DEFAULT_CONNECTION_ID } from "../connections/types";
import {
  connectionSettingsPrefix,
  type GuiRepoSettings,
  guiSettingsPath,
  readGuiSettings,
  repoWorktreeHooksEnabled,
  terminalSurfaceCodecsEnabled,
  updateGuiSettings,
  workspaceRepoSettingsKey,
} from "../config/gui-settings";
import {
  checkoutPath as workspaceCheckoutPath,
  sourceCheckoutPath as workspaceSourceCheckoutPath,
} from "../workspace/utils";
import { optionalString } from "../utils/rpc-params";

type ReadPaseoWorktreeHooks = (
  checkoutPath: string,
  sourceCheckoutPath?: string,
) => Promise<{
  path: string;
  config: {
    setup?: string;
    opened?: string;
    teardown?: string;
    removed?: string;
  };
} | null>;

export function createSettingsRpcHandler(args: {
  connectionId?: string;
  connectionGeneration?: number;
  readSettings?: typeof readGuiSettings;
  updateSettings?: typeof updateGuiSettings;
  herdr: HerdrClient;
  sshHost: () => string | undefined;
  readPaseoWorktreeHooks: ReadPaseoWorktreeHooks;
  onTerminalTransportSettingsChanged?: (enabled: boolean) => void;
  safeSend: (
    ws: ServerWebSocket<unknown>,
    payload: string,
    context?: string,
  ) => boolean;
  markRpcError: (
    ws: ServerWebSocket<unknown>,
    id: string | null | undefined,
    detail?: string,
  ) => void;
}) {
  const readSettings = args.readSettings ?? readGuiSettings;
  const updateSettings = args.updateSettings ?? updateGuiSettings;
  const serialize = (message: Record<string, unknown>) =>
    args.connectionId
      ? serializeConnectionEnvelope(
          args.connectionId,
          message,
          args.connectionGeneration,
        )
      : JSON.stringify(message);

  function repoSettingsKey(workspace: any): string | null {
    return workspaceRepoSettingsKey(
      workspace,
      args.sshHost(),
      args.connectionId,
    );
  }

  function ownsSettingsKey(key: string): boolean {
    const host = args.sshHost();
    const prefix = `${connectionSettingsPrefix(args.connectionId)}${host ? `ssh:${host}` : "local"}:`;
    return key.startsWith(prefix);
  }

  return async function handleSettingsRpc(
    ws: ServerWebSocket<unknown>,
    id: string,
    method: string,
    params: Record<string, unknown>,
    requestIsCurrent: () => boolean = () => true,
  ) {
    const fail = (message: string) => {
      const effectiveMessage = requestIsCurrent()
        ? message
        : CONNECTION_CHANGED_DURING_REQUEST;
      args.markRpcError(ws, id, effectiveMessage);
      return args.safeSend(
        ws,
        serialize({ id, error: { message: effectiveMessage } }),
        `${method}-error`,
      );
    };
    const reply = (result: unknown) =>
      requestIsCurrent()
        ? args.safeSend(ws, serialize({ id, result }), method)
        : fail(CONNECTION_CHANGED_DURING_REQUEST);
    try {
      if (!requestIsCurrent()) return fail(CONNECTION_CHANGED_DURING_REQUEST);
      if (method === "settings.terminal_transport.get") {
        const settings = await readSettings();
        return reply({
          surface_codecs: terminalSurfaceCodecsEnabled(
            settings,
            args.connectionId,
          ),
        });
      }
      if (method === "settings.terminal_transport.update") {
        if (
          typeof params.surface_codecs !== "boolean" ||
          Object.keys(params).some((key) => key !== "surface_codecs")
        )
          return fail(
            "settings.terminal_transport.update requires only a boolean surface_codecs",
          );
        const enabled = params.surface_codecs;
        const connectionId = args.connectionId ?? LEGACY_DEFAULT_CONNECTION_ID;
        let changed = false;
        const settings = await updateSettings((current) => {
          changed =
            terminalSurfaceCodecsEnabled(current, connectionId) !== enabled;
          return {
            ...current,
            terminal_transport: {
              ...current.terminal_transport,
              [connectionId]: { surface_codecs: enabled },
            },
          };
        }, requestIsCurrent);
        if (changed) args.onTerminalTransportSettingsChanged?.(enabled);
        return reply({
          surface_codecs: terminalSurfaceCodecsEnabled(settings, connectionId),
        });
      }
      if (method === "settings.get") {
        const settings = await readSettings();
        return reply({ settings, path: guiSettingsPath() });
      }
      if (method === "settings.worktree_hooks.get") {
        const workspaceId = optionalString(params, "workspace_id") ?? "";
        if (!workspaceId) {
          return fail("settings.worktree_hooks.get requires workspace_id");
        }
        const workspaceResult = await args.herdr.call("workspace.get", {
          workspace_id: workspaceId,
        });
        const workspace = workspaceResult?.workspace;
        if (!workspace?.worktree) {
          return reply({
            workspace_id: workspaceId,
            key: null,
            enabled: true,
            hooks: {},
            paseo_path: null,
            error: "workspace has no worktree metadata",
          });
        }
        const key = repoSettingsKey(workspace);
        const checkoutPath = workspaceCheckoutPath(workspace);
        const sourceCheckoutPath = workspaceSourceCheckoutPath(workspace);
        let paseo: Awaited<ReturnType<ReadPaseoWorktreeHooks>> = null;
        let readError: string | undefined;
        try {
          paseo = await args.readPaseoWorktreeHooks(
            checkoutPath,
            sourceCheckoutPath,
          );
        } catch (e) {
          readError = (e as Error).message;
        }
        return reply({
          workspace_id: workspaceId,
          key,
          enabled: await repoWorktreeHooksEnabled(key),
          repo_name: workspace.worktree.repo_name,
          repo_root: workspace.worktree.repo_root,
          checkout_path: checkoutPath,
          source_checkout_path: sourceCheckoutPath,
          paseo_path: paseo?.path ?? null,
          hooks: paseo?.config ?? {},
          error: readError,
        });
      }
      if (method === "settings.update_repo") {
        const key = optionalString(params, "key") ?? "";
        if (!key) return fail("settings.update_repo requires key");
        if (!ownsSettingsKey(key)) {
          return fail("repository settings belong to another connection");
        }
        const patch =
          params.settings && typeof params.settings === "object"
            ? (params.settings as Partial<GuiRepoSettings>)
            : {};
        const settings = await updateSettings((current) => {
          const existing = current.repositories[key] ?? {};
          const next: GuiRepoSettings = { ...existing };
          if (typeof patch.worktree_hooks_enabled === "boolean") {
            next.worktree_hooks_enabled = patch.worktree_hooks_enabled;
          }
          if (patch.custom && typeof patch.custom === "object") {
            next.custom = { ...(existing.custom ?? {}), ...patch.custom };
          }
          return {
            ...current,
            repositories: {
              ...current.repositories,
              [key]: next,
            },
          };
        }, requestIsCurrent);
        const next = settings.repositories[key];
        return reply({ settings, repo: next, key });
      }
      return fail(`unknown settings method: ${method}`);
    } catch (e) {
      return fail((e as Error).message);
    }
  };
}
