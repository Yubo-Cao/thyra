#!/usr/bin/env bun
/**
 * Checks the terminal canvas in a real browser: crisp text and wheel scroll.
 *
 * Not part of CI or the test suite. Point it at a running demo:
 *
 *   bun run build:web
 *   bun scripts/capture-screenshots.ts --serve --port 8831   # elsewhere
 *   bun scripts/check-terminal-render.ts --url http://127.0.0.1:8831/
 *
 * Crisp text: at pixel ratios 1.25 (125% Windows scaling), 1.5 and 2 (and a 110% interface scale) every
 * terminal canvas's backing store is exactly its CSS size times the pixel
 * ratio, and it has no transform and no extra scroll layer: the compositor
 * snaps an untransformed layer to device pixels, while a transform (even a
 * sub-pixel translate meant to snap it) makes it filter the whole canvas.
 * After a pixel ratio change it follows.
 * Scrolling: 30 wheel notches over a pane with Herdr scrollback send 30
 * `terminal.scroll` requests and Herdr answers with frames, without a link
 * lookup per repaint. Exits non-zero on a failure.
 */
import { parseArgs } from "node:util";
import { loadPlaywrightCore } from "./playwright-core";

const { values } = parseArgs({
  options: { url: { type: "string" }, browser: { type: "string" } },
});
if (!values.url) throw new Error("--url <demo url> is required");
const url = values.url;
const SCREEN = ".terminal-engine-screen";
const playwright = await loadPlaywrightCore();
const browser = await playwright.chromium.launch({
  channel: values.browser ?? "chromium",
});
const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
  if (!ok) failures.push(message);
};

async function open(
  dpr: number,
  uiScale?: number,
  watch?: (page: any) => void,
) {
  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    deviceScaleFactor: dpr,
  });
  const page = await context.newPage();
  watch?.(page);
  if (uiScale) {
    await page.goto(url);
    await page.evaluate(
      (value: string) => localStorage.setItem("thyra:uiScale", value),
      String(uiScale),
    );
  }
  await page.goto(url);
  await page.waitForSelector(SCREEN);
  await page.waitForFunction(
    (selector: string) =>
      [...document.querySelectorAll<HTMLCanvasElement>(selector)].some(
        (canvas) => canvas.width > 300,
      ),
    SCREEN,
  );
  await page.waitForTimeout(1500);
  return { context, page };
}

/** Canvases whose backing store is not their device-pixel size. */
function blurryCanvases(page: any): Promise<string[]> {
  return page.evaluate((selector: string) => {
    const dpr = window.devicePixelRatio;
    return [...document.querySelectorAll<HTMLCanvasElement>(selector)]
      .filter((canvas) => canvas.offsetWidth > 0)
      .flatMap((canvas) => {
        const rect = canvas.getBoundingClientRect();
        const width = rect.width * dpr;
        const height = rect.height * dpr;
        const layered = canvas.closest(".restty-native-scroll-root");
        const style = getComputedStyle(canvas);
        const moved = style.translate !== "none" || style.transform !== "none";
        return Math.abs(width - canvas.width) > 0.05 ||
          Math.abs(height - canvas.height) > 0.05 ||
          layered ||
          moved
          ? [
              `${width}x${height} device px shows ${canvas.width}x${canvas.height}${layered ? " on a scroll layer" : ""}${moved ? ` moved by ${style.translate} ${style.transform}` : ""}`,
            ]
          : [];
      });
  }, SCREEN);
}

for (const [dpr, uiScale] of [[1.25], [1.5], [2], [2, 110]] as const) {
  const { context, page } = await open(dpr, uiScale);
  const blurry = await blurryCanvases(page);
  check(
    blurry.length === 0,
    `pixel ratio ${dpr}${uiScale ? ` at ${uiScale}%` : ""}: canvases on the device-pixel grid ${blurry.join("; ")}`,
  );
  await context.close();
}

{
  const { context, page } = await open(1);
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1400,
    height: 900,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await page.waitForTimeout(2000);
  const blurry = await blurryCanvases(page);
  check(
    blurry.length === 0,
    `pixel ratio 1 -> 2: canvases follow ${blurry.join("; ")}`,
  );
  await context.close();
}

{
  const sent: Record<string, number> = {};
  let counting = false;
  const { context, page } = await open(2, undefined, (page) =>
    page.on("websocket", (socket: any) =>
      socket.on("framesent", (frame: { payload: string | Buffer }) => {
        const method = String(frame.payload).match(/"method":"([^"]+)"/)?.[1];
        if (counting && method) sent[method] = (sent[method] ?? 0) + 1;
      }),
    ),
  );
  const screen = page.locator(SCREEN).nth(1);
  const box = await screen.boundingBox();
  await page.mouse.click(box.x + 100, box.y + box.height - 20);
  await page.keyboard.type("seq 1 300");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(2000);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  counting = true;
  for (let notch = 0; notch < 30; notch++) {
    await page.mouse.wheel(0, -100);
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(1500);
  const scrolls = sent["terminal.scroll"] ?? 0;
  const frames = sent["terminal.frame_ack"] ?? 0;
  const lookups = sent["terminal.link.resolve"] ?? 0;
  check(
    scrolls === 30 && frames >= 25 && lookups <= 2,
    `wheel: ${scrolls}/30 scroll requests, ${frames} frames, ${lookups} link lookups`,
  );
  await context.close();
}

await browser.close();
if (failures.length) process.exit(1);
