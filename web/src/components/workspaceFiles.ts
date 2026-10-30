import type { ConnectionClient } from "../api";
import { connectionHttpPath } from "../connectionHttp";
import { t } from "../i18n";
import type { FilePreview } from "../types";

/** Host paths (absolute or `~`) use filesystem scope; others are checkout-relative. */
export function isFilesystemPath(path: string) {
  return /^(?:\/|[a-z]:[\\/]|~(?:\/|$))/i.test(path);
}

/** What the host knows about a path (file contents or a directory). */
export async function readWorkspaceFile(
  client: ConnectionClient,
  workspaceId: string,
  path: string,
) {
  if (!client.isCurrent())
    throw new Error(t("connection changed during file preview"));
  const preview = (await client.call("file.read", {
    workspace_id: workspaceId,
    path,
  })) as FilePreview;
  if (!client.isCurrent())
    throw new Error(t("connection changed during file preview"));
  return preview;
}

/** Copy one file into `directory` of the workspace (or a host path). */
export async function uploadWorkspaceFile(
  client: ConnectionClient,
  workspaceId: string,
  directory: string,
  file: File,
) {
  if (!client.isCurrent())
    throw new Error(t("connection changed during upload"));
  const url = new URL(
    connectionHttpPath(
      client.connectionId,
      "/file/upload",
      client.serverRuntimeGeneration,
    ),
    window.location.origin,
  );
  if (url.origin !== window.location.origin)
    throw new Error(t("invalid upload origin"));
  url.searchParams.set("workspace_id", workspaceId);
  url.searchParams.set("directory", directory);
  url.searchParams.set("filename", file.name);
  if (isFilesystemPath(directory)) url.searchParams.set("scope", "filesystem");
  const response = await fetch(url, { method: "POST", body: file });
  const text = await response.text();
  if (!client.isCurrent())
    throw new Error(t("connection changed during upload"));
  let payload: { error?: string; path?: string };
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { error: text };
  }
  if (!response.ok)
    throw new Error(
      payload.error ||
        text ||
        t("upload failed {status}", { status: response.status }),
    );
  return payload as { path: string; size: number; overwritten: boolean };
}
