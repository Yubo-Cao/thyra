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
    tools: () => call<FileTools>("file.tools", {}),
    extract: (path: string) =>
      call<{ job_id: string }>("file.extract", { path }),
    compress: (paths: string[], format: CompressFormat) =>
      call<{ job_id: string }>("file.compress", { paths, format }),
    job: (id: string) => call<ArchiveJob>("file.job", { job_id: id }),
    cancelJob: (id: string) => call("file.job_cancel", { job_id: id }),
  };
}

export type CompressFormat = "zip" | "tar.gz";

/** What the host can do: `true`, or the tool to install. */
export type FileTools = {
  os: string;
  extract: Record<string, true | string>;
  compress: Record<CompressFormat, true | string>;
  thumbnails: { image: boolean; video: boolean; pdf: boolean };
};

export type ArchiveJob = {
  id: string;
  kind: "extract" | "compress";
  state: "running" | "done" | "failed" | "canceled";
  files: number;
  bytes: number;
  total_bytes: number;
  result?: string;
  error?: string;
};

const ARCHIVE_SUFFIXES: Array<[string, string]> = [
  [".tar.gz", "tar.gz"],
  [".tgz", "tar.gz"],
  [".tar.xz", "tar.xz"],
  [".txz", "tar.xz"],
  [".tar.zst", "tar.zst"],
  [".tzst", "tar.zst"],
  [".tar.bz2", "tar.bz2"],
  [".tbz2", "tar.bz2"],
  [".tbz", "tar.bz2"],
  [".tar", "tar"],
  [".zip", "zip"],
  [".jar", "zip"],
  [".7z", "7z"],
  [".rar", "rar"],
];

/** The archive format a name has (the keys of `FileTools.extract`). */
export function archiveFormatOf(name: string) {
  const lower = name.toLowerCase();
  return (
    ARCHIVE_SUFFIXES.find(([suffix]) => lower.endsWith(suffix))?.[1] ?? null
  );
}

export type FileOperationsClient = ReturnType<typeof fileOperations>;

/** Whether a failure is the server's "an entry named ... already exists". */
export function isConflictError(error: unknown) {
  return /already exists/.test((error as Error)?.message ?? "");
}
