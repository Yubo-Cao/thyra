import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  VSCODE_WORKBENCH_GLOBAL,
  VSCODE_WORKBENCH_HOOK_QUERY,
} from "../../../shared/vscodeWorkbench";
import { createVscodeProxy } from "./proxy";
import {
  isHookedWorkbenchScript,
  withHookedWorkbenchScript,
  withWorkbenchHook,
} from "./workbench-script";

const COMMIT = "2c33b50b16c472efe58357d1d2a8a5414bc23fbf";
const SCRIPT_PATH = `/vscode/stable-${COMMIT}/static/out/vs/code/browser/workbench/workbench.js`;
/** `create()` as VS Code 1.144 minifies it, between unrelated `open()` calls. */
const CREATE =
  'x.open().then(a=>{a.focus()});var ccr=!1,oG=new co;function pGo(s,o){if(En("code/didLoadWorkbenchMain"),ccr)throw new Error("Unable to create the VSCode workbench more than once.");ccr=!0;let e;return new tVi(s,o).open().then(t=>{e=t,oG.complete(t)}),j(()=>{e?e.shutdown():oG.p.then(t=>t.shutdown())})}y.open().then(b=>{b.close()});';
const HOOK = `globalThis.${VSCODE_WORKBENCH_GLOBAL}=`;

describe("the workbench script hook", () => {
  test("stores the embedder API as the workbench starts", () => {
    const hooked = withWorkbenchHook(CREATE);
    expect(hooked).toBe(
      CREATE.replace(".open().then(t=>{e=t,", `.open().then(t=>{${HOOK}t;e=t,`),
    );
    expect(hooked.split(HOOK)).toHaveLength(2);
  });

  test("follows the minifier's names and parentheses", () => {
    const script =
      'throw new Error("Unable to create the VSCode workbench more than once.");new B$(a,b).open().then(($w)=>{i=$w});';
    expect(withWorkbenchHook(script)).toContain(
      `.open().then(($w)=>{${HOOK}$w;i=$w});`,
    );
  });

  test("leaves a script it does not recognise unchanged", () => {
    for (const script of [
      "x.open().then(t=>{t.focus()});",
      `throw new Error("Unable to create the VSCode workbench more than once.");${" ".repeat(5000)}x.open().then(t=>{});`,
      'throw new Error("Unable to create the VSCode workbench more than once.");start(s,o);',
    ])
      expect(withWorkbenchHook(script)).toBe(script);
  });

  test("names only the workbench script with the hook query", () => {
    const hooked = (path: string) =>
      isHookedWorkbenchScript(new URL(path, "https://thyra.test"));
    expect(hooked(`${SCRIPT_PATH}?${VSCODE_WORKBENCH_HOOK_QUERY}`)).toBe(true);
    expect(hooked(SCRIPT_PATH)).toBe(false);
    expect(hooked(`${SCRIPT_PATH}?other=1`)).toBe(false);
    expect(
      hooked(
        `${SCRIPT_PATH.replace("workbench.js", "other.js")}?${VSCODE_WORKBENCH_HOOK_QUERY}`,
      ),
    ).toBe(false);
  });

  test("points the page at the hooked script and nothing else", () => {
    const html = `<script type="module" src="/vscode/stable-${COMMIT}/static/out/nls.messages.js"></script><script type="module" src="${SCRIPT_PATH}"></script>`;
    expect(withHookedWorkbenchScript(html)).toBe(
      html.replace(
        "workbench.js",
        `workbench.js?${VSCODE_WORKBENCH_HOOK_QUERY}`,
      ),
    );
    expect(withHookedWorkbenchScript("<html></html>")).toBe("<html></html>");
  });
});

describe("the proxied workbench script", () => {
  /** Long enough for the static cache to compress. */
  const BUNDLE = `${CREATE}//${"x".repeat(4096)}`;
  let upstream: ReturnType<typeof Bun.serve>;
  beforeAll(() => {
    upstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const { pathname } = new URL(req.url);
        if (pathname === "/vscode/")
          return new Response(
            `<html><head><meta id="vscode-workbench-web-configuration" data-settings="{}"></head><script type="module" src="${SCRIPT_PATH}"></script></html>`,
            { headers: { "content-type": "text/html" } },
          );
        if (pathname === SCRIPT_PATH)
          return new Response(BUNDLE, {
            headers: {
              "content-type": "text/javascript",
              "content-length": String(BUNDLE.length),
            },
          });
        return new Response("Not found", { status: 404 });
      },
    });
  });
  afterAll(() => upstream.stop(true));

  const get = (pathname: string, headers: Record<string, string> = {}) => {
    const url = new URL(pathname, "https://thyra.test");
    return createVscodeProxy({
      upstream: `http://127.0.0.1:${upstream.port}`,
    }).fetchHttp(new Request(url, { headers }), url);
  };

  test("carries the hook under the URL the page loads", async () => {
    const html = await (await get("/vscode/?folder=/srv/app")).text();
    const src = html.match(/src="([^"]*workbench\.js[^"]*)"/)?.[1];
    expect(src).toBe(`${SCRIPT_PATH}?${VSCODE_WORKBENCH_HOOK_QUERY}`);

    const hooked = withWorkbenchHook(BUNDLE);
    const compressed = await get(src!, { "accept-encoding": "gzip" });
    expect(compressed.headers.get("content-encoding")).toBe("gzip");
    expect(compressed.headers.get("cache-control")).toContain("immutable");
    expect(
      new TextDecoder().decode(Bun.gunzipSync(await compressed.bytes())),
    ).toBe(hooked);

    // A client that takes no compression skips the cache, not the hook.
    const plain = await get(src!, { "accept-encoding": "identity" });
    expect(plain.headers.get("content-encoding")).toBeNull();
    expect(await plain.text()).toBe(hooked);
  });

  test("stays as VS Code has it under its own URL", async () => {
    const response = await get(SCRIPT_PATH, { "accept-encoding": "identity" });
    expect(await response.text()).toBe(BUNDLE);
  });
});
