/**
 * The contract between the VS Code proxy and the page that frames the editor:
 * the proxy's copy of the workbench script stores VS Code's embedder API under
 * this name on the editor's window.
 */
export const VSCODE_WORKBENCH_GLOBAL = "thyraWorkbench";

/** Marks the URL of that copy; change it when the hook changes. */
export const VSCODE_WORKBENCH_HOOK_QUERY = "thyra=1";
