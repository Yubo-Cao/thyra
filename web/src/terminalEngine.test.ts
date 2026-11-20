import { expect, test } from "bun:test";
import {
  createResttyRuntime,
  createResttyRuntimeSession,
} from "restty/internal/runtime";
import { terminalFontOptions } from "./appearance";

test("UI scale changes the Retina grid in a fixed-size terminal viewport", async () => {
  const font = await Bun.file(
    new URL(
      "../public/assets/fonts/maple-mono-nf-cn/400/b008bd5b4b.woff2",
      import.meta.url,
    ),
  ).arrayBuffer();
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { devicePixelRatio: 2 },
  });
  try {
    const canvas = {
      width: 1600,
      height: 1000,
    } as HTMLCanvasElement;
    const options = terminalFontOptions(false, 105);
    // Load real cell metrics without starting a browser renderer.
    const runtime = createResttyRuntime({
      mount: { canvas, session: createResttyRuntimeSession() },
      terminal: {
        fontSize: options.fontSize,
        fontSizeMode: "em",
        attachCanvasEvents: false,
        attachWindowEvents: false,
      },
    }) as ReturnType<typeof createResttyRuntime> & {
      host: {
        grid(): { cols: number; rows: number };
        setLineHeight(value: number): void;
      };
    };
    runtime.host.setLineHeight(options.lineHeight);
    await runtime.terminal.setFonts([font]);
    const before = runtime.host.grid();
    expect(before.cols).toBeGreaterThan(0);
    expect(before.rows).toBeGreaterThan(0);

    runtime.terminal.setFontSize(terminalFontOptions(false, 110).fontSize);
    const after = runtime.host.grid();
    expect(after.cols).toBeLessThan(before.cols);
    expect(after.rows).toBeLessThan(before.rows);

    runtime.terminal.setFontSize(options.fontSize);
    expect(runtime.host.grid()).toEqual(before);
  } finally {
    if (originalWindow) {
      Object.defineProperty(globalThis, "window", originalWindow);
    } else {
      delete (globalThis as { window?: unknown }).window;
    }
  }
});
