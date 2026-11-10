import { filterListResult } from "../authz/filters";
import { sanitizeConnectionError } from "../connections/manager";
import type { LegacyConnectionRuntime } from "../connections/runtime";
import { runProcessWithCodeTimeout, shQuote } from "../utils/process-utils";
import { optionalString } from "../utils/rpc-params";
import { syncWorktreeBase } from "../worktree/create";
import {
  linkedWorktreeCheckoutPath,
  removeWorktreeWithRecovery,
  WORKTREE_REMOVE_TIMEOUT_MS,
} from "../worktree/remove";
import type { ConnectionRpcContext, RpcHandler } from "./context";

async function listAgents(ctx: ConnectionRpcContext) {
  const { id, params, sendReply, sendError, roles, scope, connection } = ctx;
  try {
    const result = await connection.agentSessions.listWithActivity(
      params ?? {},
    );
    sendReply(
      {
        id,
        result: roles ? filterListResult(result, roles, scope) : result,
      },
      "agent-list",
    );
  } catch (e) {
    sendError("agent-list-error", e);
  }
}

async function listFiles(ctx: ConnectionRpcContext) {
  const { id, params, sendReply, sendError } = ctx;
  const { listWorkspaceFiles } = ctx.connection.files;
  try {
    const result = await listWorkspaceFiles(params ?? {});
    sendReply({ id, result }, "file-list");
  } catch (e) {
    sendError("file-list-error", e);
  }
}

async function resolveFiles(ctx: ConnectionRpcContext) {
  const { id, params, sendReply, sendError } = ctx;
  const { resolveWorkspaceFiles } = ctx.connection.files;
  try {
    const result = await resolveWorkspaceFiles(params ?? {});
    sendReply({ id, result }, "file-resolve");
  } catch (e) {
    sendError("file-resolve-error", e);
  }
}

async function readFile(ctx: ConnectionRpcContext) {
  const { id, params, sendReply, sendError } = ctx;
  const { readWorkspaceFile } = ctx.connection.files;
  try {
    const result = await readWorkspaceFile(params ?? {});
    sendReply({ id, result }, "file-read");
  } catch (e) {
    sendError("file-read-error", e);
  }
}

async function writeFile(ctx: ConnectionRpcContext) {
  const { id, params, sendReply, sendError } = ctx;
  const { writeWorkspaceFile } = ctx.connection.files;
  const { invalidateGitStatus } = ctx.connection.status;
  try {
    const result = await writeWorkspaceFile(params ?? {});
    if (!result.scope) invalidateGitStatus(result.checkout_path);
    sendReply({ id, result }, "file-write");
  } catch (e) {
    sendError("file-write-error", e);
  }
}

async function makeDirectory(ctx: ConnectionRpcContext) {
  const { id, params, sendReply, sendError } = ctx;
  const { createWorkspaceEntry } = ctx.connection.files;
  try {
    const result = await createWorkspaceEntry(params ?? {});
    sendReply({ id, result }, "file-mkdir");
  } catch (e) {
    sendError("file-mkdir-error", e);
  }
}

/**
 * The file-manager methods a connection's `fileRpc` table names (rename,
 * transfer, trash, archives), or undefined when it does not list `method`.
 */
export function fileManagerRpcHandler(
  connection: LegacyConnectionRuntime,
  method: string,
): RpcHandler<ConnectionRpcContext> | undefined {
  const fileRpc = Object.hasOwn(connection.files.fileRpc, method)
    ? connection.files.fileRpc[method]
    : undefined;
  if (!fileRpc) return undefined;
  return async (ctx) => {
    const { id, params, sendReply, sendError } = ctx;
    const { invalidateGitStatus } = ctx.connection.status;
    try {
      const result = (await fileRpc(params ?? {})) as {
        scope?: string;
        checkout_path: string;
      };
      if (!result.scope) invalidateGitStatus(result.checkout_path);
      sendReply({ id, result }, method);
    } catch (e) {
      sendError(`${method}-error`, e);
    }
  };
}

async function gitDiffSummary(ctx: ConnectionRpcContext) {
  const { id, params, sendReply, sendError } = ctx;
  const { readGitDiffSummary } = ctx.connection.files;
  try {
    const result = await readGitDiffSummary(params ?? {});
    sendReply({ id, result }, "git-diff-summary");
  } catch (e) {
    sendError("git-diff-summary-error", e);
  }
}

async function gitDiffFile(ctx: ConnectionRpcContext) {
  const { id, params, sendReply, sendError } = ctx;
  const { readGitDiffFile } = ctx.connection.files;
  try {
    const result = await readGitDiffFile(params ?? {});
    sendReply({ id, result }, "git-diff-file");
  } catch (e) {
    sendError("git-diff-file-error", e);
  }
}

async function gitPull(ctx: ConnectionRpcContext) {
  const { id, params, sendReply, sendError } = ctx;
  const { runGitPull } = ctx.connection.files;
  const { invalidateGitStatus } = ctx.connection.status;
  try {
    const result = await runGitPull(params ?? {});
    invalidateGitStatus(result.root);
    sendReply({ id, result }, "git-pull");
  } catch (e) {
    sendError("git-pull-error", e);
  }
}

async function createWorktree(ctx: ConnectionRpcContext) {
  const { id, method, params, sendReply, sendError } = ctx;
  const { connectionId, requestIsCurrent } = ctx;
  const { logger } = ctx.services;
  const { sshHost, herdr, worktreeParents } = ctx.connection;
  const { resolveWorkspaceGitRoot } = ctx.connection.files;
  try {
    const workspaceId = optionalString(params, "workspace_id") ?? "";
    const baseSync = await syncWorktreeBase({
      workspaceId,
      resolveGitRoot: async (id) =>
        resolveWorkspaceGitRoot({ workspace_id: id }),
      host: sshHost(),
      shQuote,
      runProcessWithCodeTimeout,
    });
    const result = await herdr.call(method, {
      ...(params ?? {}),
      base: baseSync.commit,
    });
    // Herdr identifies the repository but not which of several workspaces
    // for that repository initiated creation. Keep that GUI relationship.
    await worktreeParents
      .rememberWorktreeParent(result, workspaceId, requestIsCurrent)
      .catch((error) => {
        if (!requestIsCurrent()) return;
        logger.warn("unable to persist worktree parent", {
          connection: connectionId,
          error: sanitizeConnectionError(error),
        });
      });
    sendReply(
      { id, result: { ...result, base_sync: baseSync } },
      "worktree-create",
    );
  } catch (e) {
    sendError("worktree-create-error", e);
  }
}

async function openWorktree(ctx: ConnectionRpcContext) {
  const { id, method, params, sendReply, sendError } = ctx;
  const { connectionId, requestIsCurrent } = ctx;
  const { logger } = ctx.services;
  const { herdr, worktreeParents } = ctx.connection;
  try {
    const workspaceId = optionalString(params, "workspace_id") ?? "";
    const result = await herdr.call(method, params ?? {});
    await worktreeParents
      .rememberWorktreeParent(result, workspaceId, requestIsCurrent)
      .catch((error) => {
        if (!requestIsCurrent()) return;
        logger.warn("unable to persist opened worktree parent", {
          connection: connectionId,
          error: sanitizeConnectionError(error),
        });
      });
    sendReply({ id, result }, "worktree-open");
  } catch (e) {
    sendError("worktree-open-error", e);
  }
}

async function removeWorktree(ctx: ConnectionRpcContext) {
  const { id, params, sendReply, sendError } = ctx;
  const { connectionId, requestIsCurrent } = ctx;
  const { logger } = ctx.services;
  const {
    herdr,
    worktreeParents,
    worktreeRemovalCoordinator,
    worktreeRemovalRuntime,
  } = ctx.connection;
  try {
    const workspaceId = optionalString(params, "workspace_id") ?? "";
    const result = await worktreeRemovalCoordinator.run(
      workspaceId,
      async () => {
        const checkoutPath = await linkedWorktreeCheckoutPath(
          (name, callParams) => herdr.call(name, callParams),
          workspaceId,
        );
        const removal = await removeWorktreeWithRecovery({
          call: (name, callParams) =>
            herdr.call(name, callParams, WORKTREE_REMOVE_TIMEOUT_MS),
          params: params ?? {},
          checkoutPath,
          runtime: worktreeRemovalRuntime,
        });
        if (removal.cleanup?.preserved_path) {
          logger.warn("preserved stale worktree files", {
            connection: connectionId,
            path: removal.cleanup.preserved_path,
          });
        }
        if (checkoutPath) {
          await worktreeParents
            .forgetWorktree(checkoutPath, requestIsCurrent)
            .catch((error) => {
              if (!requestIsCurrent()) return;
              logger.warn("unable to remove worktree parent", {
                connection: connectionId,
                error: sanitizeConnectionError(error),
              });
            });
        }
        return {
          ...removal.result,
          ...(removal.cleanup ? { cleanup: removal.cleanup } : {}),
        };
      },
    );
    sendReply({ id, result }, "worktree-remove");
  } catch (e) {
    sendError("worktree-remove-error", e);
  }
}

/** Agents, files, git and worktrees of one connection's workspaces. */
export const workspaceRpcMethods: Record<
  string,
  RpcHandler<ConnectionRpcContext>
> = {
  "agent.list": listAgents,
  "file.list": listFiles,
  "file.resolve": resolveFiles,
  "file.read": readFile,
  "file.write": writeFile,
  "file.mkdir": makeDirectory,
  "git.diff_summary": gitDiffSummary,
  "git.diff_file": gitDiffFile,
  "git.pull": gitPull,
  "worktree.create": createWorktree,
  "worktree.open": openWorktree,
  "worktree.remove": removeWorktree,
};
