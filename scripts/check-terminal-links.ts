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
 * In the demo's shell pane it runs `scripts/demo/link-screen.ts`, which
 * prints the link shapes coding agents print (plain URLs inside and at the
 * start of a row, an OSC 8 hyperlink, a URL soft-wrapped across two rows, a
 * Claude Code style URL hard-wrapped into two OSC 8 parts, and an absolute
 * path with spaces), then repaints a spinner and a status row every 80 ms.
 * At pixel ratio 1.25 (125% Windows scaling) and 2 it checks that the pointer
 * lands on the right cell, that hovering a link underlines it with a pointer
 * cursor, that Ctrl+click (Cmd where Thyra sees a Mac) after a 300-800 ms
 * hover opens each URL, every time, in a new tab with noopener, that the
 * spaced path opens in the file preview, and that a plain click opens no URL.
 * Exits non-zero on a failure.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { linkScreen } from "./demo/link-screen";
import { loadPlaywrightCore } from "./playwright-core";

const { values } = parseArgs({
  options: { url: { type: "string" }, browsers: { type: "string" } },
});
if (!values.url) throw new Error("--url <demo url> is required");
const url = values.url;
const SCREEN = ".terminal-engine-screen";
const DIRECTORY = "/tmp/thyra-link-check/My Folder";
const FILE = `${DIRECTORY}/file name.ts`;
const REPORT = "/tmp/thyra-link-check/screen.json";
const SCREEN_SCRIPT = join(import.meta.dir, "demo/link-screen.ts");
// How long each click rests on its link first, as a person's hover does.
const HOVER_RESTS = [300, 800, 450, 650, 350, 550];
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
  rmSync(REPORT, { force: true });
  await page.keyboard.type(
    `mkdir -p '${DIRECTORY}' && touch '${FILE}' && clear && ${process.execPath} ${SCREEN_SCRIPT} ${REPORT} '${FILE}'`,
  );
  await page.keyboard.press("Enter");
  for (let i = 0; i < 100 && !existsSync(REPORT); i++)
    await page.waitForTimeout(100);
  const { cols } = JSON.parse(readFileSync(REPORT, "utf8")) as {
    cols: number;
  };
  const layout = linkScreen(cols, FILE);
  await page.waitForTimeout(1000);
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

  // The first row: "plain https://example.com/plain here"; find the cell size.
  const rowY = (row: number, cellH: number) => box.y + (row + 0.5) * cellH;
  // Playwright's WebKit reports a Mac, so Thyra expects Cmd there.
  const modifier = (await page.evaluate(() =>
    /Mac|iPhone|iPad/.test(navigator.userAgent),
  ))
    ? "Meta"
    : "Control";
  const plain = layout.plain;
  await page.keyboard.down(modifier);
  await page.mouse.move(box.x + 60, rowY(0, 10));
  await page.waitForTimeout(400);
  let hover = await underline();
  const cellW = hover.width / plain.url.length;
  const cellH = hover.top + 1;
  check(
    hover.shown &&
      hover.cursor === "pointer" &&
      Math.abs(hover.left - plain.col * cellW) < 0.5,
    `${label}: Ctrl+hover underlines the URL from its first cell with a pointer (${JSON.stringify(hover)})`,
  );
  // Cell edges: the space before the URL is no link, its first cell is.
  await page.mouse.move(box.x + plain.col * cellW - 1, rowY(0, cellH));
  await page.waitForTimeout(300);
  const before = await underline();
  await page.mouse.move(box.x + plain.col * cellW + 1, rowY(0, cellH));
  await page.waitForTimeout(300);
  const first = await underline();
  check(
    !before.shown && first.shown,
    `${label}: hit-testing splits the cells at the URL's left edge`,
  );

  // Each link the way a person clicks it: move onto it, rest 300-800 ms
  // while the spinner rows keep repainting, then click. Every click must
  // open exactly that link's URL.
  const cellX = (col: number) => box.x + (col + 0.5) * cellW;
  const ctrlClicks = async (
    name: string,
    row: number,
    col: number,
    expected: string,
  ) => {
    let hits = 0;
    const wrong: string[] = [];
    for (const rest of HOVER_RESTS) {
      await page.mouse.move(cellX(0), rowY(layout.spinnerRow + 1, cellH));
      await page.waitForTimeout(150);
      const count = (await opened()).length;
      await page.mouse.move(cellX(col), rowY(row, cellH));
      await page.waitForTimeout(rest);
      await page.mouse.down();
      await page.mouse.up();
      await page.waitForTimeout(250);
      const urls = (await opened()).slice(count);
      if (
        urls.length === 1 &&
        urls[0]![0] === expected &&
        urls[0]![1] === "_blank" &&
        /noopener/.test(urls[0]![2] ?? "")
      )
        hits++;
      else if (urls.length) wrong.push(...urls.map((url: string[]) => url[0]!));
    }
    check(
      hits === HOVER_RESTS.length && !wrong.length,
      `${label}: Ctrl+click on ${name} opens it ${hits}/${HOVER_RESTS.length} times${wrong.length ? `, other URLs ${JSON.stringify(wrong)}` : ""}`,
    );
  };
  await ctrlClicks(
    "a plain URL inside a row",
    plain.row,
    plain.col + 3,
    plain.url,
  );
  await ctrlClicks(
    "a plain URL that starts its row",
    layout.first.row,
    layout.first.col + 5,
    layout.first.url,
  );
  await ctrlClicks(
    "an OSC 8 hyperlink",
    layout.osc.row,
    layout.osc.col + 3,
    layout.osc.url,
  );
  await ctrlClicks(
    "a soft-wrapped URL's first row",
    layout.soft.row,
    10,
    layout.soft.url,
  );
  await ctrlClicks(
    "a soft-wrapped URL's second row",
    layout.soft.tailRow,
    Math.floor(layout.soft.tailLength / 2),
    layout.soft.url,
  );
  await ctrlClicks(
    "a hard-wrapped OSC 8 URL's first row",
    layout.hard.row,
    layout.hard.col + 10,
    layout.hard.url,
  );
  await ctrlClicks(
    "a hard-wrapped OSC 8 URL's second row",
    layout.hard.tailRow,
    layout.hard.col + Math.floor(layout.hard.tailLength / 2),
    layout.hard.url,
  );

  // The absolute path with spaces; hover inside "name".
  const nameCol = FILE.indexOf("name") + 1;
  await page.mouse.move(cellX(nameCol), rowY(layout.file.row, cellH));
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
  await page.mouse.move(box.x + (plain.col + 3) * cellW, rowY(0, cellH));
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
