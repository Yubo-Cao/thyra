import { VSCODE_WORKBENCH_GLOBAL } from "../../../shared/vscodeWorkbench";
import type { InspectorFileRequest } from "../workspaceResource";

/** VS Code's command for opening an editor on a resource. */
const OPEN_EDITOR_COMMAND = "_workbench.open";

/** The part of VS Code Web's embedder API the Inspector uses. */
export type EditorWorkbench = {
  commands: {
    executeCommand(command: string, ...args: unknown[]): Promise<unknown>;
  };
};

function joinPath(root: string, path: string) {
  if (path.startsWith("/")) return path;
  return `${root.replace(/\/+$/, "")}/${path.replace(/^\.?\//, "")}`;
}

/** The editor page for a folder, opening `file` as it loads. */
export function editorUrl(
  origin: string,
  folder: string,
  file?: InspectorFileRequest,
) {
  const url = new URL("/vscode/", origin);
  url.searchParams.set("folder", folder);
  if (file) {
    const target = `vscode-remote://${url.host}${joinPath(folder, file.path)}`;
    url.searchParams.set(
      "payload",
      JSON.stringify([
        ["openFile", file.line ? `${target}:${file.line}` : target],
        ...(file.line ? [["gotoLineMode", "true"]] : []),
      ]),
    );
  }
  return `${url.pathname}${url.search}`;
}

/**
 * The embedder API of a loaded editor: the proxy's workbench script stores it
 * on the editor's window once the workbench has started. Null while the
 * editor loads, and for a VS Code build the proxy could not hook.
 */
export function editorWorkbench(
  frame: HTMLIFrameElement | null | undefined,
): EditorWorkbench | null {
  try {
    const candidate = (
      frame?.contentWindow as unknown as Record<string, unknown> | null
    )?.[VSCODE_WORKBENCH_GLOBAL] as Partial<EditorWorkbench> | undefined;
    return typeof candidate?.commands?.executeCommand === "function"
      ? (candidate as EditorWorkbench)
      : null;
  } catch {
    // The frame left this origin.
    return null;
  }
}

/** Opens `file` in a running editor; false when the editor refused. */
export async function openInEditor(
  workbench: EditorWorkbench,
  host: string,
  folder: string,
  file: InspectorFileRequest,
): Promise<boolean> {
  try {
    await workbench.commands.executeCommand(
      OPEN_EDITOR_COMMAND,
      {
        scheme: "vscode-remote",
        authority: host,
        path: joinPath(folder, file.path),
      },
      [
        undefined,
        {
          pinned: true,
          ...(file.line
            ? { selection: { startLineNumber: file.line, startColumn: 1 } }
            : {}),
        },
      ],
    );
    return true;
  } catch {
    return false;
  }
}
