import { expect, test } from "bun:test";
import type { TerminalLink } from "./terminalEngine";
import { TerminalLinkHover } from "./terminalLinkHover";

const event = (x: number, y: number) => ({ x, y }) as unknown as MouseEvent;

function fixture(deferred = false) {
  const shown: string[] = [];
  const replies: Array<() => void> = [];
  let lookups = 0;
  const link = (): TerminalLink => ({
    text: "https://example.com",
    range: { start: { x: 5, y: 2 }, end: { x: 23, y: 2 } },
    activate() {},
  });
  const hover = new TerminalLinkHover({
    cell: (e) => e as unknown as { x: number; y: number },
    show: (item) => shown.push(item.text),
    hide: () => shown.push("hidden"),
  });
  hover.register({
    provideLinks(y, reply) {
      lookups++;
      const answer = () => reply(y === 2 ? [link()] : undefined);
      if (deferred) replies.push(answer);
      else answer();
    },
  });
  return { hover, shown, replies, lookups: () => lookups };
}

test("scrolls drop links; only a pointer on a new row looks them up", () => {
  const { hover, shown, lookups } = fixture();
  hover.move(event(1, 1));
  hover.move(event(8, 1));
  expect(lookups()).toBe(1);
  hover.move(event(8, 2));
  expect(lookups()).toBe(2);
  expect(shown).toEqual(["https://example.com"]);
  for (let i = 0; i < 30; i++) hover.refresh();
  expect(lookups()).toBe(2);
  expect(hover.hovered).toBeNull();
  hover.move(event(9, 2));
  expect(lookups()).toBe(3);
  expect(hover.hovered?.text).toBe("https://example.com");
  hover.move(event(30, 2));
  expect(lookups()).toBe(3);
  expect(hover.hovered).toBeNull();
});

test("repaints keep a hovered link for the click and re-evaluate it sparingly", () => {
  const { hover, lookups } = fixture();
  hover.move(event(8, 2));
  const first = hover.hovered;
  expect(first?.text).toBe("https://example.com");
  // Live output (an agent spinner) repaints many times a second.
  for (let i = 0; i < 30; i++) hover.repaint();
  expect(hover.hovered).toBe(first);
  expect(lookups()).toBe(1);
  hover.dispose();
});

test("repaints never look up rows without a hovered link", () => {
  const { hover, lookups } = fixture();
  hover.move(event(8, 1));
  for (let i = 0; i < 30; i++) hover.repaint();
  expect(lookups()).toBe(1);
  hover.move(event(9, 1));
  expect(lookups()).toBe(2);
});

test("a slow lookup survives repaints and still shows its link", () => {
  const { hover, replies, lookups } = fixture(true);
  hover.move(event(8, 2));
  for (let i = 0; i < 10; i++) hover.repaint();
  expect(hover.hovered).toBeNull();
  replies.shift()!();
  expect(hover.hovered?.text).toBe("https://example.com");
  expect(lookups()).toBe(1);
  hover.dispose();
});

test("a re-evaluation that finds no link under the pointer hides it", () => {
  let present = true;
  const shown: string[] = [];
  const hover = new TerminalLinkHover({
    cell: (e) => e as unknown as { x: number; y: number },
    show: (item) => shown.push(item.text),
    hide: () => shown.push("hidden"),
  });
  const pending: Array<() => void> = [];
  hover.register({
    provideLinks(_y, reply) {
      const links = present
        ? [
            {
              text: "a/b.ts",
              range: { start: { x: 1, y: 2 }, end: { x: 6, y: 2 } },
              activate() {},
            },
          ]
        : undefined;
      pending.push(() => reply(links));
    },
  });
  hover.move(event(3, 2));
  pending.shift()!();
  expect(hover.hovered?.text).toBe("a/b.ts");
  present = false;
  // Lookups older than the throttle window re-evaluate at once.
  (hover as unknown as { row: { started: number } }).row.started -= 1000;
  hover.repaint();
  expect(hover.hovered?.text).toBe("a/b.ts");
  pending.shift()!();
  expect(hover.hovered).toBeNull();
  expect(shown).toEqual(["a/b.ts", "hidden"]);
});
