import {
  VSCODE_WORKBENCH_GLOBAL,
  VSCODE_WORKBENCH_HOOK_QUERY,
} from "../../../shared/vscodeWorkbench";

/**
 * VS Code Web's server build bundles the workbench into one module that
 * exports nothing an embedding page can call: its command service is
 * reachable only from inside. The bundle does build the embedder API object
 * (`commands.executeCommand`, ...) and resolves a module-private promise with
 * it. Thyra's copy of the script also stores that object on the editor's
 * window, so the page that frames the editor can run a command in it, such as
 * opening a file, without reloading it.
 */
const WORKBENCH_SCRIPT = /\/out\/vs\/code\/browser\/workbench\/workbench\.js$/;
const WORKBENCH_SCRIPT_SRC =
  /(<script\b[^>]*\bsrc="[^"?]*\/out\/vs\/code\/browser\/workbench\/workbench\.js)(")/;

/** `create()` is the only place this message appears. */
const CREATE_MARKER = "Unable to create the VSCode workbench more than once";
/** `new BrowserMain(...).open().then(workbench => {`, minified. */
const WORKBENCH_READY = /\.open\(\)\.then\(\(?([\w$]+)\)?=>\{/g;
/** How far past the marker the rest of `create()` may reach. */
const CREATE_LENGTH = 4096;

/** Whether this request is for the copy of the script that carries the hook. */
export function isHookedWorkbenchScript(url: URL) {
  return (
    WORKBENCH_SCRIPT.test(url.pathname) &&
    url.search === `?${VSCODE_WORKBENCH_HOOK_QUERY}`
  );
}

/**
 * Points the workbench page at the hooked copy of its script. The query keeps
 * it apart from an unhooked copy a browser already holds as immutable.
 */
export function withHookedWorkbenchScript(html: string): string {
  return html.replace(
    WORKBENCH_SCRIPT_SRC,
    (_match, src: string, close: string) =>
      `${src}?${VSCODE_WORKBENCH_HOOK_QUERY}${close}`,
  );
}

/**
 * Stores the embedder API on the window once the workbench has started. A
 * script without the expected `create()` comes back unchanged, and the page
 * then opens files by reloading the editor.
 */
export function withWorkbenchHook(script: string): string {
  const marker = script.indexOf(CREATE_MARKER);
  if (marker < 0) return script;
  WORKBENCH_READY.lastIndex = marker;
  const ready = WORKBENCH_READY.exec(script);
  if (!ready || ready.index > marker + CREATE_LENGTH) return script;
  const at = ready.index + ready[0].length;
  return `${script.slice(0, at)}globalThis.${VSCODE_WORKBENCH_GLOBAL}=${ready[1]};${script.slice(at)}`;
}
