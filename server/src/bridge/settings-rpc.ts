import type { ServerWebSocket } from "bun";
import {
  CONNECTION_CHANGED_DURING_REQUEST,
  serializeConnectionEnvelope,
} from "../connections/protocol";
import { LEGACY_DEFAULT_CONNECTION_ID } from "../connections/types";
import {
  guiSettingsPath,
  readGuiSettings,
  terminalSurfaceCodecsEnabled,
  updateGuiSettings,
} from "../config/gui-settings";

export function createSettingsRpcHandler(args: {
  connectionId?: string;
  connectionGeneration?: number;
  readSettings?: typeof readGuiSettings;
  updateSettings?: typeof updateGuiSettings;
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
      return fail(`unknown settings method: ${method}`);
    } catch (e) {
      return fail((e as Error).message);
    }
  };
}
