import { describe, expect, test } from "bun:test";
import { VSCODE_WORKBENCH_GLOBAL } from "../../../shared/vscodeWorkbench";
import { editorUrl, editorWorkbench, openInEditor } from "./vscodeEditor";

const ORIGIN = "https://thyra.test:8443";

function frame(contentWindow: unknown) {
  return { contentWindow } as unknown as HTMLIFrameElement;
}

function recordingWorkbench(fail = false) {
  const calls: unknown[][] = [];
  return {
    calls,
    commands: {
      executeCommand: async (...args: unknown[]) => {
        calls.push(args);
        if (fail) throw new Error("command '_workbench.open' not found");
      },
    },
  };
}

describe("the editor page URL", () => {
  test("names the folder", () => {
    expect(editorUrl(ORIGIN, "/srv/my app")).toBe(
      "/vscode/?folder=%2Fsrv%2Fmy+app",
    );
  });

  test("opens a file, at a line when one is given", () => {
    const payload = (file: Parameters<typeof editorUrl>[2]) =>
      JSON.parse(
        new URL(editorUrl(ORIGIN, "/srv/app/", file), ORIGIN).searchParams.get(
          "payload",
        )!,
      );
    expect(payload({ path: "./src/a.ts", nonce: 1 })).toEqual([
      ["openFile", "vscode-remote://thyra.test:8443/srv/app/src/a.ts"],
    ]);
    expect(payload({ path: "/etc/hosts", line: 7, nonce: 2 })).toEqual([
      ["openFile", "vscode-remote://thyra.test:8443/etc/hosts:7"],
      ["gotoLineMode", "true"],
    ]);
  });
});

describe("a running editor", () => {
  test("is found by the API its script stores on the window", () => {
    const workbench = recordingWorkbench();
    expect(
      editorWorkbench(frame({ [VSCODE_WORKBENCH_GLOBAL]: workbench })),
    ).toBe(workbench);
  });

  test("is absent while it loads, without the hook, or off this origin", () => {
    expect(editorWorkbench(undefined)).toBeNull();
    expect(editorWorkbench(frame(null))).toBeNull();
    expect(editorWorkbench(frame({}))).toBeNull();
    expect(
      editorWorkbench(frame({ [VSCODE_WORKBENCH_GLOBAL]: { commands: {} } })),
    ).toBeNull();
    const foreign = new Proxy(
      {},
      {
        get() {
          throw new DOMException("Blocked a frame", "SecurityError");
        },
      },
    );
    expect(editorWorkbench(frame(foreign))).toBeNull();
  });

  test("opens a file as a pinned editor on the remote", async () => {
    const workbench = recordingWorkbench();
    expect(
      await openInEditor(workbench, "thyra.test:8443", "/srv/app", {
        path: "src/a b#1.ts",
        nonce: 1,
      }),
    ).toBe(true);
    expect(workbench.calls).toEqual([
      [
        "_workbench.open",
        {
          scheme: "vscode-remote",
          authority: "thyra.test:8443",
          path: "/srv/app/src/a b#1.ts",
        },
        [undefined, { pinned: true }],
      ],
    ]);
  });

  test("selects the requested line", async () => {
    const workbench = recordingWorkbench();
    await openInEditor(workbench, "thyra.test", "/srv/app", {
      path: "/etc/hosts",
      line: 7,
      nonce: 2,
    });
    expect(workbench.calls[0]?.slice(1)).toEqual([
      { scheme: "vscode-remote", authority: "thyra.test", path: "/etc/hosts" },
      [
        undefined,
        { pinned: true, selection: { startLineNumber: 7, startColumn: 1 } },
      ],
    ]);
  });

  test("reports a refused command so the caller can reload instead", async () => {
    expect(
      await openInEditor(recordingWorkbench(true), "thyra.test", "/srv/app", {
        path: "a.ts",
        nonce: 3,
      }),
    ).toBe(false);
  });
});
