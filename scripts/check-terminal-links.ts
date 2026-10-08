#!/usr/bin/env bun
/**
 * Checks Ctrl+click on terminal links in real browsers (Chromium and WebKit).
 *
 * Not part of CI or the test suite. Point it at a running demo:
 *
 *   bun run build:web
 *   bun scripts/capture-screenshots.ts --serve --port 8831   # elsewhere
 *   bun scripts/check-terminal-links.ts --url http://127.0.0.1:8831/
 *
 * In the demo's shell pane it prints a URL and an absolute path with spaces,
 * then keeps the pane repainting the way agent spinners do. At pixel ratio
 * 1.25 (125% Windows scaling) and 2 it checks that the pointer lands on the
 * right cell, that hovering a link underlines it with a pointer cursor, that
 * Ctrl+click (Cmd where Thyra sees a Mac) opens the URL in a new tab with noopener and the
 * spaced path in the file preview, and that a plain click opens no URL.
 * Exits non-zero on a failure.
 */
import { parseArgs } from "node:util";
import { loadPlaywrightCore } from "./playwright-core";

const { values } = parseArgs({
  options: { url: { type: "string" }, browsers: { type: "string" } },
});
if (!values.url) throw new Error("--url <demo url> is required");
const url = values.url;
const SCREEN = ".terminal-engine-screen";
const DIRECTORY = "/tmp/thyra-link-check/My Folder";
const FILE = `${DIRECTORY}/file name.ts`;
const URL_TEXT = "https://example.com/x";
const playwright = await loadPlaywrightCore();
const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
  if (!ok) failures.push(message);
};

async function run(kind: "chromium" | "webkit", dpr: number) {
  const label = `${kind} at ${dpr}x`;
  const browser = await playwright[kind].launch();
  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    deviceScaleFactor: dpr,
  });
  await context.addInitScript(() => {
    if (window.PushManager)
      PushManager.prototype.getSubscription = async () => null;
    const opened: string[][] = [];
    Object.assign(window, { __opened: opened });
    window.open = ((target: string, name: string, features: string) => {
      opened.push([target, name, features]);
      return null;
    }) as typeof window.open;
  });
  const page = await context.newPage();
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
  // The demo's last pane is a shell.
  const index = (await page.locator(SCREEN).count()) - 1;
  const screen = page.locator(SCREEN).nth(index);
  let box = await screen.boundingBox();
  await page.mouse.click(box.x + 100, box.y + box.height - 20);
  await page.keyboard.press("Control+c");
  await page.keyboard.type(
    `mkdir -p '${DIRECTORY}' && touch '${FILE}' && clear && printf 'url ${URL_TEXT} here\\n${FILE}:12\\n' && while :; do printf '\\r%s' $RANDOM; sleep 0.1; done`,
  );
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1500);
  box = await screen.boundingBox();
  const underline = () =>
    page.evaluate(
      ({ selector, index }: { selector: string; index: number }) => {
        const canvas = document.querySelectorAll<HTMLElement>(selector)[index]!;
        const line = canvas.parentElement!.querySelector<HTMLElement>(
          ".terminal-engine-link",
        )!;
        const bounds = canvas.getBoundingClientRect();
        const rect = line.getBoundingClientRect();
        return {
          shown: !line.hidden,
          left: rect.left - bounds.left,
          top: rect.top - bounds.top,
          width: rect.width,
          cursor: canvas.style.cursor,
        };
      },
      { selector: SCREEN, index },
    );
  const opened = () =>
    page.evaluate(
      () => (window as unknown as { __opened: string[][] }).__opened,
    );
  const backing = await page.evaluate(
    ({ selector, index }: { selector: string; index: number }) => {
      const canvas =
        document.querySelectorAll<HTMLCanvasElement>(selector)[index]!;
      const rect = canvas.getBoundingClientRect();
      return {
        css: [rect.width, rect.height],
        device: [canvas.width, canvas.height],
      };
    },
    { selector: SCREEN, index },
  );
  check(
    Math.abs(backing.css[0]! * dpr - backing.device[0]!) < 0.05 &&
      Math.abs(backing.css[1]! * dpr - backing.device[1]!) < 0.05,
    `${label}: canvas ${backing.device.join("x")} is its CSS size ${backing.css.join("x")} times ${dpr}`,
  );

  // The first row: "url https://example.com/x here"; find the cell width.
  const rowY = (row: number, cellH: number) => box.y + (row + 0.5) * cellH;
  // Playwright's WebKit reports a Mac, so Thyra expects Cmd there.
  const modifier = (await page.evaluate(() =>
    /Mac|iPhone|iPad/.test(navigator.userAgent),
  ))
    ? "Meta"
    : "Control";
  await page.keyboard.down(modifier);
  await page.mouse.move(box.x + 60, rowY(0, 10));
  await page.waitForTimeout(400);
  let hover = await underline();
  const cellW = hover.width / URL_TEXT.length;
  const cellH = hover.top + 1;
  check(
    hover.shown &&
      hover.cursor === "pointer" &&
      Math.abs(hover.left - 4 * cellW) < 0.5,
    `${label}: Ctrl+hover underlines the URL from its first cell with a pointer (${JSON.stringify(hover)})`,
  );
  // Cell edges: the space before the URL is no link, its first cell is.
  await page.mouse.move(box.x + 4 * cellW - 1, rowY(0, cellH));
  await page.waitForTimeout(300);
  const before = await underline();
  await page.mouse.move(box.x + 4 * cellW + 1, rowY(0, cellH));
  await page.waitForTimeout(300);
  const first = await underline();
  check(
    !before.shown && first.shown,
    `${label}: hit-testing splits the cells at the URL's left edge`,
  );
  // Let the repainting pane run, without moving the pointer.
  await page.waitForTimeout(1200);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(300);
  const urls = await opened();
  check(
    urls.length === 1 &&
      urls[0]![0] === URL_TEXT &&
      urls[0]![1] === "_blank" &&
      /noopener/.test(urls[0]![2] ?? ""),
    `${label}: Ctrl+click opens the URL in a new tab with noopener (${JSON.stringify(urls)})`,
  );

  // The second row: the absolute path with spaces; hover inside "name".
  const nameCol = FILE.indexOf("name") + 1;
  await page.mouse.move(box.x + (nameCol + 0.5) * cellW, rowY(1, cellH));
  await page.waitForTimeout(800);
  hover = await underline();
  check(
    hover.shown && Math.abs(hover.width - FILE.length * cellW) < 0.5,
    `${label}: the spaced path underlines whole (${JSON.stringify(hover)})`,
  );
  await page.waitForTimeout(1200);
  await page.mouse.down();
  await page.mouse.up();
  await page.keyboard.up(modifier);
  // The canvas draws the terminal; page text is the preview's header.
  const previewed = await page
    .waitForFunction(
      (path: string) => document.body.innerText.includes(path),
      DIRECTORY,
      { timeout: 5000 },
    )
    .then(() => true)
    .catch(() => false);
  check(
    previewed,
    `${label}: Ctrl+click opens the spaced path in the file preview`,
  );

  // A plain click on the URL opens nothing (the preview may have resized it).
  const shell = page.locator(SCREEN).last();
  box = await shell.boundingBox();
  const tabs = (await opened()).length;
  await page.mouse.move(box.x + 8 * cellW, rowY(0, cellH));
  await page.waitForTimeout(400);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(300);
  check(
    (await opened()).length === tabs,
    `${label}: a plain click on the URL opens no tab`,
  );
  await shell.click({ position: { x: 100, y: box.height - 20 } });
  await page.keyboard.press("Control+c");
  await context.close();
  await browser.close();
}

const browsers = (values.browsers ?? "chromium,webkit").split(",");
for (const kind of browsers as Array<"chromium" | "webkit">)
  for (const dpr of [1.25, 2]) await run(kind, dpr);
if (failures.length) process.exit(1);
