/**
 * A pane screen for `scripts/check-terminal-links.ts`: the link shapes coding
 * agents print, kept repainting the way their spinners and status lines do.
 *
 *   bun scripts/demo/link-screen.ts <report.json> <file path>
 *
 * Draws the layout from `linkScreen()` for the pane's width, writes the width
 * and height to the report file so the checker can find each link, then
 * repaints the spinner and status rows every 80 ms until interrupted.
 */
import { writeFileSync } from "node:fs";

const ESC = "\u001b";
const osc8 = (target: string, label: string) =>
  `${ESC}]8;;${target}${ESC}\\${label}${ESC}]8;;${ESC}\\`;

/** Rows are 0-based; columns are 0-based cells. */
export function linkScreen(cols: number, file: string) {
  const plain = "https://example.com/plain";
  const first = "https://example.com/first-token";
  const osc = "https://example.com/osc8-target";
  // Longer than the row, printed without a newline: Herdr soft-wraps it, but
  // the cropped frame Thyra receives has no wrap flags.
  const soft = `https://example.com/soft/${"a".repeat(Math.max(1, cols - 13))}/end`;
  // Claude Code style: a long URL broken at its box width with a hard newline
  // and the box's indentation, each part an OSC 8 link to the whole URL.
  const hard = `https://example.com/claude/${"b".repeat(Math.max(1, cols - 21))}/end`;
  const head = hard.slice(0, cols - 2);
  const tail = hard.slice(cols - 2);
  return {
    plain: { url: plain, row: 0, col: 6 },
    first: { url: first, row: 1, col: 2 },
    osc: { url: osc, row: 2, col: 6, label: "open the docs" },
    soft: {
      url: soft,
      row: 3,
      col: 0,
      tailRow: 4,
      tailLength: soft.length - cols,
    },
    hard: { url: hard, row: 5, col: 2, tailRow: 6, tailLength: tail.length },
    file: { path: file, row: 7 },
    spinnerRow: 8,
    statusRow: 10,
    text: [
      `plain ${plain} here\r\n`,
      `  ${first}\r\n`,
      `docs: ${osc8(osc, "open the docs")}\r\n`,
      `${soft}\r\n`,
      `  ${osc8(hard, head)}\r\n  ${osc8(hard, tail)}\r\n`,
      `${file}:12\r\n`,
    ].join(""),
  };
}

if (import.meta.main) {
  const [report, file = "/tmp/file.ts"] = process.argv.slice(2);
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;
  const screen = linkScreen(cols, file);
  // Hide the cursor, clear, then draw from the top like a full-screen agent.
  process.stdout.write(`${ESC}[?25l${ESC}[H${ESC}[2J${ESC}[3J${screen.text}`);
  if (report) writeFileSync(report, JSON.stringify({ cols, rows }));
  const glyphs = "·✢✳✶✻✽";
  const started = Date.now();
  let tick = 0;
  const timer = setInterval(() => {
    tick++;
    const seconds = Math.floor((Date.now() - started) / 1000);
    let out = `${ESC}[${screen.spinnerRow + 1};1H${ESC}[2K${glyphs[tick % glyphs.length]} Working… (${seconds}s · ${tick} tokens · esc to interrupt)`;
    if (screen.statusRow < rows)
      out += `${ESC}[${screen.statusRow + 1};1H${ESC}[2K  ? for shortcuts  ${tick % 97}`;
    process.stdout.write(out);
  }, 80);
  const stop = () => {
    clearInterval(timer);
    process.stdout.write(`${ESC}[?25h${ESC}[${rows};1H\r\n`);
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
