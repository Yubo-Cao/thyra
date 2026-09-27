import { describe, expect, test } from "bun:test";
import {
  DEFAULT_TOAST_TIMEOUT_MS,
  ToastController,
  type ToastContent,
  type ToastOptions,
  type ToastSink,
} from "./toastQueue";

class FakeSink implements ToastSink {
  toasts = new Map<
    string,
    { content: ToastContent; options: Required<ToastOptions> }
  >();
  log: string[] = [];
  private next = 0;
  add(content: ToastContent, options: Required<ToastOptions>) {
    const key = `k${++this.next}`;
    this.toasts.set(key, { content, options });
    this.log.push(`add ${key} ${String(content.title)} ${options.timeout}`);
    return key;
  }
  update(key: string, content: ToastContent, options: Required<ToastOptions>) {
    if (!this.toasts.has(key)) return null;
    this.toasts.set(key, { content, options });
    this.log.push(`update ${key} ${String(content.title)}`);
    return key;
  }
  close(key: string) {
    const toast = this.toasts.get(key);
    if (!toast) return;
    this.toasts.delete(key);
    this.log.push(`close ${key}`);
    toast.options.onClose();
  }
}

describe("toast controller", () => {
  test("buffers toasts until a region attaches, then replays in order", () => {
    const controller = new ToastController();
    let requests = 0;
    controller.subscribe(() => requests++);
    expect(controller.requested).toBe(false);
    const first = controller.show({ title: "one" });
    controller.show({ title: "two", loading: true });
    controller.update(first, { title: "one!" });
    expect(requests).toBe(1);
    expect(controller.requested).toBe(true);

    const sink = new FakeSink();
    controller.attach(sink);
    expect(sink.log).toEqual([
      `add k1 one! ${DEFAULT_TOAST_TIMEOUT_MS}`,
      "add k2 two 0",
    ]);
  });

  test("closing a buffered toast never reaches the sink", () => {
    const controller = new ToastController();
    const closed: string[] = [];
    const id = controller.show(
      { title: "gone" },
      { onClose: () => closed.push("gone") },
    );
    controller.close(id);
    expect(closed).toEqual(["gone"]);
    const sink = new FakeSink();
    controller.attach(sink);
    expect(sink.log).toEqual([]);
    expect(controller.update(id, { title: "late" })).toBe(false);
  });

  test("forwards updates and closes once attached", () => {
    const controller = new ToastController();
    const sink = new FakeSink();
    controller.attach(sink);
    const closed: string[] = [];
    const id = controller.show(
      { title: "saving", loading: true },
      { onClose: () => closed.push(id) },
    );
    expect(
      controller.update(
        id,
        { title: "saved", loading: false },
        { timeout: 1000 },
      ),
    ).toBe(true);
    expect(sink.toasts.get("k1")?.options.timeout).toBe(1000);
    controller.close(id);
    expect(sink.log).toEqual([
      "add k1 saving 0",
      "update k1 saved",
      "close k1",
    ]);
    expect(closed).toEqual([id]);
    expect(controller.openIds).toEqual([]);
  });

  test("a toast dismissed inside the region is forgotten", () => {
    const controller = new ToastController();
    const sink = new FakeSink();
    controller.attach(sink);
    const id = controller.show({ title: "x" });
    sink.close("k1");
    expect(controller.openIds).toEqual([]);
    expect(controller.update(id, { title: "y" })).toBe(false);
  });

  test("a region clearing its queue on unmount does not drop toasts", () => {
    const controller = new ToastController();
    const first = new FakeSink();
    const detach = controller.attach(first);
    controller.show({ title: "kept" });
    detach();
    first.close("k1");
    const second = new FakeSink();
    controller.attach(second);
    expect(second.log).toEqual([`add k1 kept ${DEFAULT_TOAST_TIMEOUT_MS}`]);
  });

  test("detaching keeps open toasts for the next region", () => {
    const controller = new ToastController();
    const first = new FakeSink();
    const detach = controller.attach(first);
    controller.show({ title: "kept" }, { timeout: 0 });
    detach();
    const second = new FakeSink();
    controller.attach(second);
    expect(second.log).toEqual(["add k1 kept 0"]);
    controller.clear();
    expect(controller.openIds).toEqual([]);
  });
});
