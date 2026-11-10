import {
  connectionRoutingErrorResponse,
  type ParsedConnectionHttpRoute,
  publishConnectionHttpResponse,
  resolveConnectionHttpRoute,
} from "../connections/http-routing";
import type { ConnectionManager } from "../connections/manager";
import {
  ConnectionRoutingError,
  type LegacyRoutingLogger,
} from "../connections/protocol";
import type { LegacyConnectionRuntime } from "../connections/runtime";

/** The connection-scoped HTTP endpoints: Herdr info, uploads and files. */
export function createConnectionHttpHandler(deps: {
  connectionManager: ConnectionManager<LegacyConnectionRuntime>;
  legacyRoutingLogger: LegacyRoutingLogger;
}) {
  const { connectionManager, legacyRoutingLogger } = deps;
  return async function handleConnectionHttpRequest(
    route: ParsedConnectionHttpRoute,
    url: URL,
    req: Request,
  ): Promise<Response> {
    if (route.kind === "error") {
      return connectionRoutingErrorResponse(route.error);
    }

    let resolved: ReturnType<
      typeof resolveConnectionHttpRoute<LegacyConnectionRuntime>
    >;
    const generationText = url.searchParams.get("connection_generation");
    const requestedGeneration =
      generationText === null
        ? undefined
        : /^(0|[1-9]\d*)$/.test(generationText)
          ? Number(generationText)
          : generationText;
    try {
      resolved = resolveConnectionHttpRoute({
        route,
        requestedGeneration,
        registry: connectionManager,
        legacyLogger: legacyRoutingLogger,
      });
    } catch (error) {
      if (error instanceof ConnectionRoutingError) {
        return connectionRoutingErrorResponse(error);
      }
      return Response.json(
        { error: "connection routing failed" },
        { status: 500 },
      );
    }

    const { runtime: connection, endpoint } = resolved;
    try {
      let response: Response;
      if (endpoint === "herdr-info") {
        response = await connection.handleHerdrInfo();
      } else if (endpoint === "upload-image") {
        response = await connection.handleImageUpload(req);
      } else if (endpoint === "file-download") {
        try {
          response = await connection.files.downloadWorkspaceFile({
            workspace_id: url.searchParams.get("workspace_id"),
            path: url.searchParams.get("path"),
            scope: url.searchParams.get("scope"),
            inline: url.searchParams.get("inline") === "1",
          });
        } catch (error) {
          response = new Response((error as Error).message, { status: 400 });
        }
      } else if (endpoint === "file-thumbnail") {
        try {
          response = await connection.files.thumbnailWorkspaceFile(
            Object.fromEntries(url.searchParams),
          );
        } catch (error) {
          response = new Response((error as Error).message, { status: 400 });
        }
      } else if (endpoint === "file-upload") {
        try {
          const result = await connection.files.uploadWorkspaceFile(
            {
              workspace_id: url.searchParams.get("workspace_id"),
              directory: url.searchParams.get("directory"),
              filename: url.searchParams.get("filename"),
              scope: url.searchParams.get("scope"),
            },
            req,
          );
          response = Response.json(result);
        } catch (error) {
          response = Response.json(
            { error: (error as Error).message },
            {
              status: (error as Error).message.startsWith("file too large")
                ? 413
                : 400,
            },
          );
        }
      } else {
        try {
          const result = await connection.files.deleteWorkspaceFile({
            workspace_id: url.searchParams.get("workspace_id"),
            path: url.searchParams.get("path"),
            scope: url.searchParams.get("scope"),
          });
          response = Response.json(result);
        } catch (error) {
          response = Response.json(
            { error: (error as Error).message },
            { status: 400 },
          );
        }
      }
      return publishConnectionHttpResponse(resolved, response);
    } catch (error) {
      return publishConnectionHttpResponse(
        resolved,
        Response.json({ error: (error as Error).message }, { status: 500 }),
      );
    }
  };
}
