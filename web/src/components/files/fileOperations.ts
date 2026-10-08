import type { ConnectionClient } from "../../api";
import { t } from "../../i18n";

/** File-manager RPCs; every call names its scope like file.list does. */
export function fileOperations(
  client: ConnectionClient,
  workspaceId: string,
  filesystem: boolean,
) {
  const call = async <T>(method: string, params: Record<string, unknown>) => {
    if (!client.isCurrent()) throw new Error(t("The connection changed."));
    const result = (await client.call(method, {
      workspace_id: workspaceId,
      ...(filesystem ? { scope: "filesystem" } : {}),
      ...params,
    })) as T;
    if (!client.isCurrent()) throw new Error(t("The connection changed."));
    return result;
  };
  return {
    rename: (path: string, name: string) =>
      call<{ path: string }>("file.rename", { path, name }),
    transfer: (params: {
      paths: string[];
      destination: string;
      mode: "move" | "copy";
      conflict?: "fail" | "rename" | "replace";
    }) =>
      call<{ items: Array<{ from: string; path: string }> }>(
        "file.transfer",
        params,
      ),
    trash: (paths: string[]) =>
      call<{
        method: "freedesktop" | "macos" | "thyra";
        items: Array<{ path: string; token: string }>;
      }>("file.trash", { paths }),
    restore: (tokens: string[]) =>
      call<{ paths: string[] }>("file.restore", { tokens }),
  };
}

export type FileOperationsClient = ReturnType<typeof fileOperations>;

/** Whether a failure is the server's "an entry named ... already exists". */
export function isConflictError(error: unknown) {
  return /already exists/.test((error as Error)?.message ?? "");
}
