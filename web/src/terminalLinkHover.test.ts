import { expect, test } from "bun:test";
import type { TerminalLink } from "./terminalEngine";
import { TerminalLinkHover } from "./terminalLinkHover";

const event = (x: number, y: number) => ({ x, y }) as unknown as MouseEvent;

function fixture() {
  const shown: string[] = [];
  let lookups = 0;
  const link: TerminalLink = {
    text: "https://example.com",
    range: { start: { x: 5, y: 2 }, end: { x: 23, y: 2 } },
    activate() {},
  };
  const hover = new TerminalLinkHover({
    cell: (e) => e as unknown as { x: number; y: number },
    show: (item) => shown.push(item.text),
    hide: () => shown.push("hidden"),
  });
  hover.register({
    provideLinks(y, reply) {
      lookups++;
      reply(y === 2 ? [link] : undefined);
    },
  });
  return { hover, shown, lookups: () => lookups };
}

test("repaints never look links up again; only a pointer on a new row does", () => {
  const { hover, shown, lookups } = fixture();
  hover.move(event(1, 1));
  hover.move(event(8, 1));
  expect(lookups()).toBe(1);
  hover.move(event(8, 2));
  expect(lookups()).toBe(2);
  expect(shown).toEqual(["https://example.com"]);
  // Streaming output or a scroll refreshes the terminal many times.
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
