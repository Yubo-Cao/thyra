import { homedir } from "node:os";
import { posix } from "node:path";
import type { HerdrClient } from "../bridge/herdr-client";
import { sshCommandArgv } from "../bridge/ssh-command";
import { checkoutPath as getCheckoutPath } from "./utils";
import {
  downloadContentDisposition,
  expandHomePath,
  inlineContentDisposition,
  isHomeRelativePath,
  sanitizeExplorerPath,
  sanitizeFilesystemPath,
  sanitizePreviewPath,
  sanitizeUploadFilename,
  splitFilesystemPath,
} from "./file-paths";
import type {
  FileCreateResult,
  FileResolution,
  RunProcessWithCodeTimeout,
} from "./file-types";
import {
  createLocalEntry,
  deleteLocalFile,
  downloadLocalFile,
  listLocalFiles,
  readLocalFile,
  resolveLocalFilePaths,
  uploadLocalFile,
  writeLocalFile,
} from "./local-files";
import {
  createRemoteEntry,
  deleteRemoteFile,
  downloadRemoteFile,
  listRemoteFiles,
  readRemoteFile,
  readRemoteHome,
  resolveRemoteFilePaths,
  uploadRemoteFile,
  writeRemoteFile,
} from "./remote-files";
import { pullGit, readDiffFile, readDiffSummary } from "./git-diff";
import { collectIgnoredNames } from "./git-ignore";
import { GIT_DIFF_TIMEOUT_MS } from "./file-constants";
import { inlinePreviewMimeForPath } from "./preview";
import {
  HTML_PREVIEW_MAX_BYTES,
  isHtmlPath,
} from "../../../shared/filePreview";
import { HtmlPreviewError, readHtmlPreviewFile } from "./html-preview-files";
import { HTML_PREVIEW_CSP, renderHtmlPreview } from "./html-preview";
import { optionalString } from "../utils/rpc-params";
import {
  type ConflictPolicy,
  TRANSFER_MAX_PATHS,
  createFileOperations,
} from "./file-manager";
import {
  sharedThumbnailService,
  snapThumbnailSize,
  thumbnailKind,
  type ThumbnailService,
} from "./file-thumbnails";

const MAX_FILE_RESOLUTION_CANDIDATES = 32;
const MAX_FILE_RESOLUTION_PATH_LENGTH = 4096;

export function createFileHandlers({
  herdr,
  sshHost,
  runProcessWithCodeTimeout,
  shQuote,
  thumbnails = sharedThumbnailService(),
}: {
  herdr: HerdrClient;
  sshHost: () => string | undefined;
  runProcessWithCodeTimeout: RunProcessWithCodeTimeout;
  shQuote: (value: string) => string;
  thumbnails?: ThumbnailService;
}) {
  const remoteHomes = new Map<string, Promise<string>>();
  const operations = createFileOperations();

  /** Home of the runtime user on the host that owns the files. */
  async function hostHome(host: string | undefined) {
    if (!host) return homedir();
    let home = remoteHomes.get(host);
    if (!home) {
      home = readRemoteHome({ host, runProcessWithCodeTimeout, shQuote });
      remoteHomes.set(host, home);
      home.catch(() => {
        if (remoteHomes.get(host) === home) remoteHomes.delete(host);
      });
    }
    return home;
  }

  /** Sanitize an explicit host path and expand `~` on the runtime host. */
  async function filesystemPath(value: unknown, host: string | undefined) {
    const path = sanitizeFilesystemPath(value);
    return isHomeRelativePath(path)
      ? expandHomePath(path, await hostHome(host))
      : path;
  }

  async function explorerRoot(
    workspaceId: string,
    workspace: any,
  ): Promise<string> {
    const checkoutPath = getCheckoutPath(workspace);
    if (checkoutPath) return checkoutPath;
    const paneResult = await herdr.call("pane.list");
    const panes = Array.isArray((paneResult as any)?.panes)
      ? (paneResult as any).panes
      : [];
    const pane =
      panes.find((p: any) => p?.workspace_id === workspaceId && p?.focused) ??
      panes.find((p: any) => p?.workspace_id === workspaceId);
    return (
      (typeof pane?.foreground_cwd === "string" && pane.foreground_cwd) ||
      (typeof pane?.cwd === "string" && pane.cwd) ||
      ""
    );
  }

  async function getWorkspace(workspaceId: string) {
    const result = await herdr.call("workspace.get", {
      workspace_id: workspaceId,
    });
    return (result as any)?.workspace ?? result;
  }

  async function fileTarget(params: Record<string, unknown>, method: string) {
    const workspaceId = optionalString(params, "workspace_id") ?? "";
    if (!workspaceId) throw new Error(`${method} requires workspace_id`);
    const path =
      params.scope === "filesystem"
        ? await filesystemPath(params.path, sshHost())
        : sanitizePreviewPath(params.path);
    if (!path) throw new Error(`${method} requires path`);
    const workspace = await getWorkspace(workspaceId);
    const checkoutPath = await explorerRoot(workspaceId, workspace);
    if (!checkoutPath) throw new Error("workspace has no directory path");
    return { workspaceId, workspace, checkoutPath, path };
  }

  async function downloadTarget(params: Record<string, unknown>) {
    const workspaceId = optionalString(params, "workspace_id") ?? "";
    if (!workspaceId) throw new Error("file.download requires workspace_id");
    const path =
      params.scope === "filesystem"
        ? await filesystemPath(params.path, sshHost())
        : sanitizeExplorerPath(params.path);
    if (!path) throw new Error("file.download requires path");
    const workspace = await getWorkspace(workspaceId);
    const checkoutPath = await explorerRoot(workspaceId, workspace);
    if (!checkoutPath) throw new Error("workspace has no directory path");
    return { checkoutPath, path };
  }

  /**
   * Upload, delete, and create run against a root plus a root-relative path.
   * Workspace scope roots at the checkout and confines the path lexically.
   * Filesystem scope roots at the explicit host directory itself (upload) or
   * at the named entry's parent (delete/create), so the same helpers apply.
   */
  async function mutationTarget(
    params: Record<string, unknown>,
    method: string,
    pathKey: "path" | "directory",
  ) {
    const workspaceId = optionalString(params, "workspace_id") ?? "";
    if (!workspaceId) throw new Error(`${method} requires workspace_id`);
    const workspace = await getWorkspace(workspaceId);
    const checkoutPath = await explorerRoot(workspaceId, workspace);
    if (!checkoutPath) throw new Error("workspace has no directory path");
    if (params.scope !== "filesystem") {
      const path = sanitizeExplorerPath(params[pathKey]);
      if (!path && pathKey === "path")
        throw new Error(`${method} requires path`);
      return { workspaceId, rootPath: checkoutPath, path, filesystem: false };
    }
    const absolute = await filesystemPath(params[pathKey], sshHost());
    if (pathKey === "directory") {
      return { workspaceId, rootPath: absolute, path: "", filesystem: true };
    }
    const { parent, name } = splitFilesystemPath(absolute);
    return { workspaceId, rootPath: parent, path: name, filesystem: true };
  }

  /**
   * The workspace, host and path form of a file-manager request. Workspace
   * scope confines checkout-relative paths lexically (no `..`, no absolute
   * paths) and joins them to the checkout; filesystem scope takes absolute
   * host paths or `~`. `toHost` returns absolute host paths and `toScope`
   * maps them back to what the browser sent.
   */
  async function fileScope(params: Record<string, unknown>, method: string) {
    const workspaceId = optionalString(params, "workspace_id") ?? "";
    if (!workspaceId) throw new Error(`${method} requires workspace_id`);
    const workspace = await getWorkspace(workspaceId);
    const checkoutPath = (await explorerRoot(workspaceId, workspace)).replace(
      /(.)\/+$/,
      "$1",
    );
    if (!checkoutPath) throw new Error("workspace has no directory path");
    const host = sshHost();
    const filesystem = params.scope === "filesystem";
    const home = filesystem ? (await hostHome(host)).replace(/\/+$/, "") : "";
    return {
      workspaceId,
      host,
      filesystem,
      checkoutPath,
      /** Paths an operation may never move, rename or delete. */
      protectedPaths: filesystem
        ? new Set(["/", home])
        : new Set([checkoutPath]),
      async toHost(value: unknown, allowRoot = false) {
        if (filesystem) {
          return posix
            .normalize(await filesystemPath(value, host))
            .replace(/(.)\/+$/, "$1");
        }
        const relative = sanitizeExplorerPath(value);
        if (!relative && !allowRoot) throw new Error(`${method} requires path`);
        if (!relative) return checkoutPath;
        return `${checkoutPath === "/" ? "" : checkoutPath}/${relative}`;
      },
      toScope(path: string) {
        if (filesystem || path === checkoutPath) return filesystem ? path : "";
        return path.startsWith(`${checkoutPath}/`)
          ? path.slice(checkoutPath.length + 1)
          : path;
      },
    };
  }

  async function thumbnailFile(params: Record<string, unknown>) {
    const scope = await fileScope(params, "file.thumbnail");
    const path = await scope.toHost(params.path);
    const bytes = thumbnailKind(path)
      ? await thumbnails.thumbnail({
          host: scope.host,
          path,
          mtimeMs: Number(params.mtime) || 0,
          bytes: Number(params.bytes) || 0,
          size: snapThumbnailSize(params.size),
        })
      : null;
    // The URL names the listing's mtime, so a thumbnail never goes stale;
    // "none" is rechecked soon in case a tool was installed.
    return bytes
      ? new Response(Buffer.from(bytes), {
          headers: {
            "content-type": "image/webp",
            "cache-control": "private, max-age=604800, immutable",
            "x-content-type-options": "nosniff",
          },
        })
      : new Response(null, {
          status: 204,
          headers: { "cache-control": "private, max-age=600" },
        });
  }

  type FileScope = Awaited<ReturnType<typeof fileScope>>;

  function scopeReply(scope: FileScope, result: Record<string, unknown>) {
    return {
      workspace_id: scope.workspaceId,
      checkout_path: scope.checkoutPath,
      ...(scope.filesystem ? { scope: "filesystem" as const } : {}),
      ...result,
    };
  }

  async function scopePaths(scope: FileScope, value: unknown) {
    if (!Array.isArray(value) || !value.length) {
      throw new Error("paths must be a non-empty array");
    }
    if (value.length > TRANSFER_MAX_PATHS) {
      throw new Error(`at most ${TRANSFER_MAX_PATHS} files per operation`);
    }
    const paths = await Promise.all(value.map((path) => scope.toHost(path)));
    return Array.from(new Set(paths));
  }

  async function renameEntry(params: Record<string, unknown>) {
    const scope = await fileScope(params, "file.rename");
    const path = await scope.toHost(params.path);
    if (scope.protectedPaths.has(path)) {
      throw new Error("refusing to rename a root directory");
    }
    const renamed = await operations.rename(scope.host, path, params.name);
    return scopeReply(scope, { path: scope.toScope(renamed) });
  }

  async function transferEntries(params: Record<string, unknown>) {
    const scope = await fileScope(params, "file.transfer");
    const mode =
      params.mode === "copy" || params.mode === "move"
        ? params.mode
        : (() => {
            throw new Error('file.transfer mode must be "move" or "copy"');
          })();
    const conflict: ConflictPolicy =
      params.conflict === "rename" || params.conflict === "replace"
        ? params.conflict
        : "fail";
    const items = await operations.transfer(scope.host, {
      paths: await scopePaths(scope, params.paths),
      destination: await scope.toHost(params.destination, true),
      mode,
      conflict,
      protectedPaths: scope.protectedPaths,
    });
    return scopeReply(scope, {
      items: items.map((item) => ({
        from: scope.toScope(item.from),
        path: scope.toScope(item.path),
      })),
    });
  }

  function joinFilesystemPath(root: string, name: string) {
    return `${root.replace(/\/+$/, "")}/${name}`;
  }

  async function listFiles(params: Record<string, unknown>) {
    const workspaceId = optionalString(params, "workspace_id") ?? "";
    if (!workspaceId) throw new Error("file.list requires workspace_id");
    const workspace = await getWorkspace(workspaceId);
    const checkoutPath = await explorerRoot(workspaceId, workspace);
    if (!checkoutPath) throw new Error("workspace has no directory path");
    const filesystem = params.scope === "filesystem";
    const host = sshHost();
    const rootPath = filesystem
      ? await filesystemPath(params.path || checkoutPath, host)
      : checkoutPath;
    const relativePath = filesystem ? "" : sanitizeExplorerPath(params.path);
    const showHidden = params.show_hidden === true;
    const list = host
      ? await listRemoteFiles({
          host,
          rootPath,
          relativePath,
          showHidden,
          runProcessWithCodeTimeout,
          shQuote,
        })
      : await listLocalFiles(rootPath, relativePath, showHidden, filesystem);
    if (list.entries.length) {
      const ignored = await collectIgnoredNames({
        host,
        directory: relativePath ? `${list.root}/${relativePath}` : list.root,
        names: list.entries.map((entry) => entry.name),
        shQuote,
      });
      if (ignored.size) {
        list.entries = list.entries.map((entry) =>
          ignored.has(entry.name) ? { ...entry, ignored: true } : entry,
        );
      }
    }
    if (filesystem) {
      const directory = list.root.replace(/\\/g, "/").replace(/\/+$/, "");
      list.entries = list.entries.map((entry) => ({
        ...entry,
        path: `${directory}/${entry.name}`,
      }));
    }
    return {
      ...list,
      ...(filesystem ? { scope: "filesystem" as const } : {}),
      workspace_id: workspaceId,
      repo_name: workspace?.worktree?.repo_name ?? workspace?.label ?? "",
      checkout_path: checkoutPath,
    };
  }

  async function readFile(params: Record<string, unknown>) {
    const { workspaceId, workspace, checkoutPath, path } = await fileTarget(
      params,
      "file.read",
    );
    const host = sshHost();
    const preview = host
      ? await readRemoteFile({
          host,
          rootPath: checkoutPath,
          requestedPath: path,
          runProcessWithCodeTimeout,
          shQuote,
        })
      : await readLocalFile(checkoutPath, path);
    return {
      ...preview,
      workspace_id: workspaceId,
      repo_name: workspace?.worktree?.repo_name ?? workspace?.label ?? "",
      checkout_path: checkoutPath,
    };
  }

  async function resolveFiles(params: Record<string, unknown>) {
    const workspaceId = optionalString(params, "workspace_id") ?? "";
    if (!workspaceId) throw new Error("file.resolve requires workspace_id");
    const rawPaths = Array.isArray(params.paths) ? params.paths : [];
    const candidates: FileResolution[] = [];
    const seen = new Set<string>();
    for (const value of rawPaths.slice(0, MAX_FILE_RESOLUTION_CANDIDATES)) {
      if (typeof value !== "string") continue;
      const candidate = value.trim();
      if (
        !candidate ||
        candidate.length > MAX_FILE_RESOLUTION_PATH_LENGTH ||
        seen.has(candidate)
      ) {
        continue;
      }
      try {
        const sanitized = sanitizePreviewPath(candidate);
        const path = sanitized.startsWith("/")
          ? sanitized
          : sanitized
              .split("/")
              .filter((part) => part && part !== ".")
              .join("/");
        if (!path) continue;
        candidates.push({ candidate, path });
        seen.add(candidate);
      } catch {
        // Invalid candidates are unresolved rather than failing the whole batch.
      }
    }
    if (candidates.length === 0) {
      return { workspace_id: workspaceId, files: [] };
    }
    const workspace = await getWorkspace(workspaceId);
    const checkoutPath = await explorerRoot(workspaceId, workspace);
    if (!checkoutPath) throw new Error("workspace has no directory path");
    const paths = Array.from(new Set(candidates.map((entry) => entry.path)));
    const host = sshHost();
    const existing = host
      ? await resolveRemoteFilePaths({
          host,
          rootPath: checkoutPath,
          requestedPaths: paths,
          runProcessWithCodeTimeout,
          shQuote,
        })
      : await resolveLocalFilePaths(checkoutPath, paths);
    const existingPaths = new Set(existing);
    return {
      workspace_id: workspaceId,
      checkout_path: checkoutPath,
      files: candidates.filter((entry) => existingPaths.has(entry.path)),
    };
  }

  async function downloadFile(params: Record<string, unknown>) {
    const { checkoutPath, path } = await downloadTarget(params);
    const host = sshHost();
    if (params.inline === true && isHtmlPath(path)) {
      const headers = {
        "content-type": "text/html; charset=utf-8",
        "content-disposition": inlineContentDisposition(path.split("/").pop()!),
        "content-security-policy": HTML_PREVIEW_CSP,
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "cache-control": "private, no-store",
      };
      try {
        const readResource = (resourcePath: string, limit: number) =>
          readHtmlPreviewFile({
            rootPath: checkoutPath,
            path: resourcePath,
            limit,
            host,
            runProcessWithCodeTimeout,
            shQuote,
          });
        const document = await readResource(path, HTML_PREVIEW_MAX_BYTES);
        return new Response(await renderHtmlPreview(document, readResource), {
          headers,
        });
      } catch (error) {
        const status = error instanceof HtmlPreviewError ? error.status : 400;
        const message =
          status === 413
            ? "HTML is too large to render, or its static resources exceed the preview limits. Use Source or Download."
            : "Unable to render HTML. Preview requires a readable UTF-8 HTML file and static resources inside the workspace. Use Source or Download.";
        return new Response(message, {
          status,
          headers: { ...headers, "content-type": "text/plain; charset=utf-8" },
        });
      }
    }
    const download = host
      ? await downloadRemoteFile({
          host,
          rootPath: checkoutPath,
          requestedPath: path,
          runProcessWithCodeTimeout,
          shQuote,
        })
      : await downloadLocalFile(checkoutPath, path);
    const inlineMime =
      params.inline === true ? inlinePreviewMimeForPath(download.path) : null;
    const headers: Record<string, string> = {
      "content-type": inlineMime ?? download.contentType,
      "content-length": String(download.size),
      "content-disposition": inlineMime
        ? inlineContentDisposition(download.filename)
        : downloadContentDisposition(download.filename),
      "x-file-path": encodeURIComponent(download.path),
    };
    if (inlineMime) {
      headers["cache-control"] = "private, no-store";
      headers["x-content-type-options"] = "nosniff";
    }
    if (inlineMime === "image/svg+xml") {
      // SVGs are inert in <img>. Keep direct navigation to the same endpoint
      // isolated too, without granting workspace content the Thyra origin.
      headers["content-security-policy"] =
        "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:";
    }
    return new Response(download.body, { headers });
  }

  async function uploadFile(params: Record<string, unknown>, request: Request) {
    const filename = sanitizeUploadFilename(params.filename);
    const {
      workspaceId,
      rootPath,
      path: directory,
      filesystem,
    } = await mutationTarget(params, "file.upload", "directory");
    const body = Buffer.from(await request.arrayBuffer());
    const host = sshHost();
    const upload = host
      ? await uploadRemoteFile({
          host,
          rootPath,
          directory,
          filename,
          body,
          shQuote,
        })
      : await uploadLocalFile(rootPath, directory, filename, body);
    return {
      workspace_id: workspaceId,
      directory: filesystem ? rootPath : directory,
      filename,
      ...upload,
      ...(filesystem
        ? {
            scope: "filesystem" as const,
            path: joinFilesystemPath(rootPath, filename),
          }
        : {}),
    };
  }

  async function deleteFile(params: Record<string, unknown>) {
    const { workspaceId, rootPath, path, filesystem } = await mutationTarget(
      params,
      "file.delete",
      "path",
    );
    const host = sshHost();
    if (
      filesystem &&
      joinFilesystemPath(rootPath, path) ===
        (await hostHome(host)).replace(/\/+$/, "")
    ) {
      throw new Error("refusing to delete the home directory");
    }
    const deleted = host
      ? await deleteRemoteFile({
          host,
          rootPath,
          requestedPath: path,
          runProcessWithCodeTimeout,
          shQuote,
        })
      : await deleteLocalFile(rootPath, path);
    return {
      workspace_id: workspaceId,
      ...deleted,
      ...(filesystem
        ? {
            scope: "filesystem" as const,
            path: joinFilesystemPath(rootPath, path),
          }
        : {}),
    };
  }

  async function createEntry(params: Record<string, unknown>) {
    const kind: FileCreateResult["type"] =
      params.kind === "directory"
        ? "directory"
        : params.kind === "file"
          ? "file"
          : (() => {
              throw new Error('file.mkdir kind must be "directory" or "file"');
            })();
    const { workspaceId, rootPath, path, filesystem } = await mutationTarget(
      params,
      "file.mkdir",
      "path",
    );
    const host = sshHost();
    const created = host
      ? await createRemoteEntry({
          host,
          rootPath,
          requestedPath: path,
          kind,
          runProcessWithCodeTimeout,
          shQuote,
        })
      : await createLocalEntry(rootPath, path, kind);
    return {
      workspace_id: workspaceId,
      ...created,
      ...(filesystem
        ? {
            scope: "filesystem" as const,
            path: joinFilesystemPath(rootPath, path),
          }
        : {}),
    };
  }

  async function writeFile(params: Record<string, unknown>) {
    const workspaceId = optionalString(params, "workspace_id") ?? "";
    if (!workspaceId) throw new Error("file.write requires workspace_id");
    const absolute = params.scope === "filesystem";
    const path = absolute
      ? sanitizeFilesystemPath(params.path)
      : sanitizeExplorerPath(params.path);
    if (!path) throw new Error("file.write requires path");
    if (typeof params.content !== "string") {
      throw new Error("file.write requires string content");
    }
    const expectedMtimeMs =
      typeof params.expected_mtime_ms === "number" &&
      Number.isFinite(params.expected_mtime_ms)
        ? params.expected_mtime_ms
        : undefined;
    const options = { absolute, expectedMtimeMs, force: params.force === true };
    const body = Buffer.from(params.content, "utf8");
    const workspace = await getWorkspace(workspaceId);
    const checkoutPath = await explorerRoot(workspaceId, workspace);
    if (!checkoutPath) throw new Error("workspace has no directory path");
    const host = sshHost();
    const written = host
      ? await writeRemoteFile({
          host,
          rootPath: checkoutPath,
          requestedPath: path,
          body,
          options,
          shQuote,
        })
      : await writeLocalFile(checkoutPath, path, body, options);
    return {
      ...written,
      ...(absolute ? { scope: "filesystem" as const } : {}),
      workspace_id: workspaceId,
      checkout_path: checkoutPath,
    };
  }

  async function gitRoot(workspaceId: string, workspace: any) {
    const host = sshHost();
    const tried = new Set<string>();
    let lastError = "workspace is not inside a git repository";

    const resolveCandidate = async (candidate: unknown) => {
      if (typeof candidate !== "string" || !candidate || tried.has(candidate)) {
        return null;
      }
      tried.add(candidate);
      const argv = host
        ? sshCommandArgv(
            host,
            `git -C ${shQuote(candidate)} rev-parse --show-toplevel`,
          )
        : ["git", "-C", candidate, "rev-parse", "--show-toplevel"];
      const result = await runProcessWithCodeTimeout(argv, GIT_DIFF_TIMEOUT_MS);
      if (result.code === 0 && result.stdout.trim())
        return result.stdout.trim();
      lastError = (
        result.stderr ||
        result.stdout ||
        "workspace is not inside a git repository"
      )
        .trim()
        .slice(0, 1000);
      return null;
    };

    // A pane's foreground process can belong to an agent plugin rather than
    // the checkout. Use stable workspace identity first, then probe pane cwd,
    // and only treat foreground_cwd as a final fallback for interactive shells.
    const workspaceRoot = await resolveCandidate(getCheckoutPath(workspace));
    if (workspaceRoot) return workspaceRoot;

    const paneResult = await herdr.call("pane.list");
    const panes = Array.isArray((paneResult as any)?.panes)
      ? (paneResult as any).panes
      : [];
    const pane =
      panes.find(
        (item: any) => item?.workspace_id === workspaceId && item?.focused,
      ) ?? panes.find((item: any) => item?.workspace_id === workspaceId);
    for (const candidate of [pane?.cwd, pane?.foreground_cwd]) {
      const root = await resolveCandidate(candidate);
      if (root) return root;
    }
    if (tried.size === 0) throw new Error("workspace has no directory path");
    throw new Error(lastError);
  }

  async function workspaceAndGitRoot(
    params: Record<string, unknown>,
    method = "git diff",
  ) {
    const workspaceId = optionalString(params, "workspace_id") ?? "";
    if (!workspaceId) throw new Error(`${method} requires workspace_id`);
    const workspace = await getWorkspace(workspaceId);
    const root = await gitRoot(workspaceId, workspace);
    return { workspaceId, workspace, root };
  }

  async function readGitDiffSummary(params: Record<string, unknown>) {
    const { workspaceId, workspace, root } = await workspaceAndGitRoot(params);
    return readDiffSummary({
      workspaceId,
      workspace,
      root,
      params,
      host: sshHost(),
      shQuote,
      runProcessWithCodeTimeout,
    });
  }

  async function readGitDiffFile(params: Record<string, unknown>) {
    const { workspaceId, root } = await workspaceAndGitRoot(params);
    return readDiffFile({
      workspaceId,
      root,
      params,
      host: sshHost(),
      shQuote,
      runProcessWithCodeTimeout,
    });
  }

  async function runGitPull(params: Record<string, unknown>) {
    const { workspaceId, root } = await workspaceAndGitRoot(params);
    return pullGit({
      workspaceId,
      root,
      host: sshHost(),
      shQuote,
      runProcessWithCodeTimeout,
    });
  }

  return {
    listWorkspaceFiles: listFiles,
    resolveWorkspaceFiles: resolveFiles,
    readWorkspaceFile: readFile,
    downloadWorkspaceFile: downloadFile,
    thumbnailWorkspaceFile: thumbnailFile,
    /** File-manager RPC methods, dispatched by name from index.ts. */
    fileRpc: {
      "file.rename": renameEntry,
      "file.transfer": transferEntries,
    } as Record<string, (params: Record<string, unknown>) => Promise<unknown>>,

    uploadWorkspaceFile: uploadFile,
    deleteWorkspaceFile: deleteFile,
    writeWorkspaceFile: writeFile,
    createWorkspaceEntry: createEntry,
    readGitDiffSummary,
    readGitDiffFile,
    runGitPull,
    resolveWorkspaceGitRoot: workspaceAndGitRoot,
  };
}
