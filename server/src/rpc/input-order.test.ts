import { expect, test } from "bun:test";
import { inputOrderKey } from "./input-order";

const key = (
  client: string,
  method: string | null,
  params?: unknown,
  connection: string | null = "local",
) => inputOrderKey(client, connection, method, { params });

test("terminal input is ordered per page, connection and terminal", () => {
  const first = key("c1", "terminal.input", { terminal_id: "t1" });
  expect(first).not.toBeNull();
  // Bytes and semantic keys of one terminal share a queue.
  expect(key("c1", "terminal.key", { terminal_id: "t1" })).toBe(first);
  expect(key("c2", "terminal.input", { terminal_id: "t1" })).not.toBe(first);
  expect(key("c1", "terminal.input", { terminal_id: "t2" })).not.toBe(first);
  expect(key("c1", "terminal.input", { terminal_id: "t1" }, "other")).not.toBe(
    first,
  );
  // Input for the page's current terminal still has a queue.
  expect(key("c1", "terminal.input", {})).toBe(key("c1", "terminal.key"));
  expect(key("c1", "terminal.input", "bad")).not.toBeNull();
});

test("pane input is ordered per pane across pages", () => {
  const first = key("c1", "pane.paste", { pane_id: "w1:p1" });
  expect(first).not.toBeNull();
  expect(key("c2", "pane.send_input", { pane_id: "w1:p1" })).toBe(first);
  expect(key("c1", "pane.paste", { pane_id: "w1:p2" })).not.toBe(first);
  expect(key("c1", "pane.paste", {})).toBeNull();
  expect(first).not.toBe(key("c1", "terminal.input", { terminal_id: "w1:p1" }));
});

test("other requests are not ordered", () => {
  expect(key("c1", "terminal.frame_ack", { terminal_id: "t1" })).toBeNull();
  expect(key("c1", "terminal.resize", { terminal_id: "t1" })).toBeNull();
  expect(key("c1", null)).toBeNull();
  expect(inputOrderKey("c1", "local", "terminal.input", null)).not.toBeNull();
});
