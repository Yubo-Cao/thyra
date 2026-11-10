import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import * as net from "node:net";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { BinReader, BinWriter, encodeFrame } from "./bincode";
import { createDisplayOwnership } from "./display-ownership";
import {
  createTerminalBridge,
  TERMINAL_FACT_LIMIT,
  TERMINAL_MAX_COLS,
} from "./terminal-bridge";
import { EndpointTerminalSession } from "./endpoint-terminal-session";
import { frameToAnsi, frameToAnsiParts } from "./frame-to-ansi";
import type { CellData, FrameData } from "./frame-codec";

const servers: net.Server[] = [];

test("a view-only join preserves the existing stream size and still receives a frame", async () => {
  const socketPath = await startEndpointServer();
  const owner = {} as ServerWebSocket<unknown>;
  const viewer = {} as ServerWebSocket<unknown>;
  const ownerMessages: string[] = [];
  const viewerMessages: string[] = [];
  const bridge = createTerminalBridge({
    clientSocketPath: socketPath,
    lookupPaneId: async () => "p1",
    safeSend: (ws, payload) => {
      (ws === owner ? ownerMessages : viewerMessages).push(payload);
      return true;
    },
    clientLabel: () => "test",
    markRpcError: () => {},
  });
  try {
    await bridge.handleTerminalRpc(owner, "owner", "terminal.attach", {
      terminal_id: "t1",
      cols: 100,
      rows: 30,
    });
    await waitForTerminalFrame(ownerMessages);
    ownerMessages.length = 0;
    await bridge.handleTerminalRpc(viewer, "viewer", "terminal.attach", {
      terminal_id: "t1",
      cols: 40,
      rows: 15,
      preserve_size: true,
    });
    expect((await waitForTerminalFrame(ownerMessages)).width).toBe(100);
    expect((await waitForTerminalFrame(viewerMessages)).width).toBe(100);
    ownerMessages.length = 0;
    await bridge.handleTerminalRpc(viewer, "control", "terminal.resize", {
      terminal_id: "t1",
      cols: 80,
      rows: 24,
    });
    expect((await waitForTerminalFrame(ownerMessages)).width).toBe(80);
  } finally {
    bridge.dispose();
  }
});
describe("display owner enforcement", () => {
  async function setup() {
    const tracker = {
      events: [] as string[],
    };
    const socketPath = await startEndpointServer({ tracker });
    const ipad = {} as ServerWebSocket<unknown>;
    const phone = {} as ServerWebSocket<unknown>;
    const messages = new Map<ServerWebSocket<unknown>, string[]>([
      [ipad, []],
      [phone, []],
    ]);
    const display = createDisplayOwnership();
    const bridge = createTerminalBridge({
      clientSocketPath: socketPath,
      lookupPaneId: async () => "p1",
      displayOwnership: display,
      socketIdentity: (ws) =>
        ws === ipad
          ? { participantId: "web-ipad", deviceKey: "device:ipad" }
          : { participantId: "web-phone", deviceKey: "device:phone" },
      safeSend: (ws, payload) => {
        messages.get(ws)!.push(payload);
        return true;
      },
      clientLabel: () => "test",
      markRpcError: () => {},
    });
    const call = async (
      ws: ServerWebSocket<unknown>,
      method: string,
      params: Record<string, unknown>,
    ) => {
      const inbox = messages.get(ws)!;
      const start = inbox.length;
      await bridge.handleTerminalRpc(ws, method, method, params);
      const reply = inbox
        .slice(start)
        .map((line) => JSON.parse(line))
        .find((line) => line.id === method);
      if (reply?.error) throw new Error(reply.error.message);
      return reply?.result;
    };
    const frameWidth = async (ws: ServerWebSocket<unknown>) => {
      const inbox = messages.get(ws)!;
      inbox.length = 0;
      return (await waitForTerminalFrame(inbox)).width;
    };
    return { bridge, display, tracker, ipad, phone, call, frameWidth };
  }

  test("only the display owner sizes a pane; other devices follow its size", async () => {
    const { bridge, tracker, ipad, phone, call, frameWidth } = await setup();
    try {
      await call(ipad, "terminal.attach", {
        terminal_id: "t1",
        cols: 120,
        rows: 40,
      });
      expect(
        (await call(ipad, "terminal.display", { pane_id: "p1", action: "pin" }))
          .display_owners,
      ).toEqual([
        expect.objectContaining({
          pane_id: "p1",
          participant_id: "web-ipad",
          pinned: true,
        }),
      ]);

      // The phone joins without preserve_size and still gets the iPad size.
      const attach = call(phone, "terminal.attach", {
        terminal_id: "t1",
        cols: 45,
        rows: 30,
      });
      expect(await frameWidth(phone)).toBe(120);
      await attach;
      tracker.events.length = 0;
      expect(
        await call(phone, "terminal.resize", {
          terminal_id: "t1",
          cols: 45,
          rows: 30,
        }),
      ).toEqual({ ok: true, skipped: true, reason: "display_owner" });
      await Bun.sleep(20);
      expect(tracker.events).not.toContain("resize");

      // "Take control and resize here" moves the display to the phone.
      await call(phone, "terminal.display", { pane_id: "p1", action: "take" });
      await call(phone, "terminal.resize", {
        terminal_id: "t1",
        cols: 45,
        rows: 30,
      });
      expect(await frameWidth(ipad)).toBe(45);
      expect(
        await call(ipad, "terminal.resize", {
          terminal_id: "t1",
          cols: 120,
          rows: 40,
        }),
      ).toMatchObject({ skipped: true });

      // Pinning again returns the size to the iPad; the phone follows.
      await call(ipad, "terminal.display", { pane_id: "p1", action: "pin" });
      await call(ipad, "terminal.resize", {
        terminal_id: "t1",
        cols: 120,
        rows: 40,
      });
      expect(await frameWidth(phone)).toBe(120);
      await call(ipad, "terminal.display", {
        pane_id: "p1",
        action: "release",
      });
      expect(
        await call(phone, "terminal.resize", {
          terminal_id: "t1",
          cols: 45,
          rows: 30,
        }),
      ).toEqual({ ok: true });
    } finally {
      bridge.dispose();
    }
  });

  test("a follower opening a new stream uses the display owner's last size", async () => {
    const { bridge, ipad, phone, call, frameWidth } = await setup();
    try {
      await call(ipad, "terminal.attach", {
        terminal_id: "t1",
        cols: 120,
        rows: 40,
      });
      await call(ipad, "terminal.display", { pane_id: "p1", action: "pin" });
      await call(ipad, "terminal.detach", { terminal_id: "t1" });
      expect(bridge.statusTerminals()).toEqual([]);
      const attach = call(phone, "terminal.attach", {
        terminal_id: "t1",
        cols: 45,
        rows: 30,
      });
      expect(await frameWidth(phone)).toBe(120);
      await attach;
    } finally {
      bridge.dispose();
    }
  });

  test("text previews read a bounded number of lines through the bridge", async () => {
    const reads: [string, number][] = [];
    const replies: string[] = [];
    const ws = {} as ServerWebSocket<unknown>;
    const bridge = createTerminalBridge({
      clientSocketPath: "/unused.sock",
      lookupPaneId: async () => null,
      readPaneText: async (paneId, lines) => {
        reads.push([paneId, lines]);
        return { text: "last lines", truncated: false };
      },
      safeSend: (_ws, payload) => {
        replies.push(payload);
        return true;
      },
      clientLabel: () => "test",
      markRpcError: () => {},
    });
    try {
      await bridge.handleTerminalRpc(ws, "a", "terminal.preview_text", {
        pane_id: "p1",
      });
      await bridge.handleTerminalRpc(ws, "b", "terminal.preview_text", {
        pane_id: "p1",
        lines: 500,
      });
      expect(reads).toEqual([["p1", 60]]);
      expect(replies.map((line) => JSON.parse(line))).toEqual([
        { id: "a", result: { text: "last lines", truncated: false } },
        {
          id: "b",
          error: { message: "lines must be an integer from 1 to 200" },
        },
      ]);
    } finally {
      bridge.dispose();
    }
  });

  test("history reads a pane's scrollback without scrolling Herdr", async () => {
    const reads: [string, number][] = [];
    const replies: string[] = [];
    const ws = {} as ServerWebSocket<unknown>;
    const bridge = createTerminalBridge({
      clientSocketPath: "/unused.sock",
      lookupPaneId: async () => null,
      readPaneHistory: async (paneId, lines) => {
        reads.push([paneId, lines]);
        return { text: "\x1b[1mold\x1b[0m\r\nnew\r\n", truncated: true };
      },
      safeSend: (_ws, payload) => {
        replies.push(payload);
        return true;
      },
      clientLabel: () => "test",
      markRpcError: () => {},
    });
    try {
      await bridge.handleTerminalRpc(ws, "a", "terminal.history", {
        pane_id: "p1",
      });
      await bridge.handleTerminalRpc(ws, "b", "terminal.history", {
        pane_id: "p1",
        lines: 5000,
      });
      expect(reads).toEqual([["p1", 1000]]);
      expect(replies.map((line) => JSON.parse(line))).toEqual([
        {
          id: "a",
          result: { text: "\x1b[1mold\x1b[0m\r\nnew\r\n", truncated: true },
        },
        {
          id: "b",
          error: { message: "lines must be an integer from 1 to 1000" },
        },
      ]);
    } finally {
      bridge.dispose();
    }
  });

  test("display requests are validated", async () => {
    const { bridge, phone, call } = await setup();
    try {
      await expect(
        call(phone, "terminal.display", { pane_id: "", action: "pin" }),
      ).rejects.toThrow("pane_id required");
      await expect(
        call(phone, "terminal.display", { pane_id: "p1", action: "steal" }),
      ).rejects.toThrow("action must be");
      await expect(
        call(phone, "terminal.stream", {
          terminal_id: "t1",
          min_frame_interval_ms: 60_000,
        }),
      ).rejects.toThrow("min_frame_interval_ms");
    } finally {
      bridge.dispose();
    }
  });
});

const serverConnections = new Set<net.Socket>();

afterEach(async () => {
  for (const connection of serverConnections) connection.destroy();
  serverConnections.clear();
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

type ServerTracker = { events: string[] };

function cell(symbol: string): CellData {
  return { symbol, fg: 0, bg: 0, modifier: 0, skip: false, hyperlink: null };
}

function writeFrame(w: BinWriter, frame: FrameData) {
  w.varint(frame.cells.length);
  for (const c of frame.cells) {
    w.string(c.symbol);
    w.varint(c.fg);
    w.varint(c.bg);
    w.varint(c.modifier);
    w.bool(c.skip);
    w.option(c.hyperlink, (v) => w.varint(v));
  }
  w.varint(frame.width);
  w.varint(frame.height);
  w.option(frame.cursor, (cur) => {
    w.varint(cur.x);
    w.varint(cur.y);
    w.bool(cur.visible);
    w.u8(cur.shape);
  });
  w.varint(frame.hyperlinks.length);
  for (const link of frame.hyperlinks) w.string(link);
  w.bytes(Buffer.alloc(0));
}

/** One pane filling a cols x rows tab, so the pane crop is the whole surface. */
function surfaceFrame(revision: number, cols: number, rows: number) {
  const w = new BinWriter();
  w.variant(13);
  w.string("boot-1");
  w.varint(1);
  w.varint(revision);
  writeFrame(w, {
    cells: Array.from({ length: cols * rows }, () => cell("x")),
    width: cols,
    height: rows,
    cursor: { x: 0, y: 0, visible: true, shape: 1 },
    hyperlinks: [],
  });
  w.varint(1);
  w.string("p1");
  w.varint(revision); // content revision
  for (let i = 0; i < 2; i++) {
    w.varint(0);
    w.varint(0);
    w.varint(cols);
    w.varint(rows);
  }
  w.bool(false); // scrollbar rect
  w.bool(false); // scroll metrics
  w.bool(true); // focused
  w.bool(false); // mouse reporting
  w.bool(false); // sgr pixel mouse
  w.bool(false); // alternate screen
  w.varint(0);
  w.varint(0);
  w.varint(0); // splits
  w.bool(false); // popup
  w.varint(0); // graphics assets
  w.varint(0); // graphics placements
  w.varint(0); // retained assets
  return encodeFrame(w.toBuffer());
}

function controlFrame(kind: string, data: unknown) {
  const w = new BinWriter();
  w.variant(20);
  w.string(kind);
  w.string(JSON.stringify(data));
  return encodeFrame(w.toBuffer());
}

function clipboardFrame(data: string) {
  const w = new BinWriter();
  w.variant(5);
  w.string(data);
  return encodeFrame(w.toBuffer());
}

/**
 * Fake Herdr endpoint: answers the hello, focuses pane p1, and repaints a
 * surface at the requested size on every hello and resize.
 */
async function startEndpointServer(
  options: {
    tracker?: ServerTracker;
    /** Sent back as an OSC 52 clipboard after pane input. */
    clipboardData?: string;
    /** Sent back as an OSC 52 clipboard after a resize. */
    clipboardOnResize?: string;
    /** Withhold every surface (the attach never becomes ready). */
    skipSurface?: boolean;
    onConnection?: (socket: net.Socket) => void;
  } = {},
) {
  const socketPath = path.join(
    tmpdir(),
    `thyra-terminal-bridge-${process.pid}-${crypto.randomUUID()}.sock`,
  );
  const server = net.createServer((socket) => {
    serverConnections.add(socket);
    options.onConnection?.(socket);
    let input = Buffer.alloc(0);
    let greeted = false;
    let revision = 0;
    const paint = (cols: number, rows: number) => {
      if (!options.skipSurface && !socket.destroyed)
        socket.write(surfaceFrame(++revision, cols, rows));
    };
    // A client may close while a frame to it is still being written.
    socket.on("error", () => {});
    socket.on("close", () => serverConnections.delete(socket));
    socket.on("data", (chunk) => {
      input = Buffer.concat([
        input,
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
      ]);
      while (input.length >= 4) {
        const length = input.readUInt32LE(0);
        if (input.length < length + 4) return;
        const reader = new BinReader(input.subarray(4, length + 4));
        input = input.subarray(length + 4);
        const variant = reader.variant();
        if (!greeted) {
          greeted = true;
          reader.string(); // kind
          const hello = JSON.parse(reader.string());
          options.tracker?.events.push("hello");
          socket.write(
            controlFrame("endpoint.welcome.v1", {
              generation: 1,
              server_version: "0.9.0",
              snapshot_codec: "shell.snapshot.v1",
              surface_codec: "shell.surface.v1",
              input_codec: "shell.input.semantic.v1",
              blob_codec: "shell.blob.v1",
              methods: ["pane.focus", "pane.scroll"],
              capabilities: [],
            }),
          );
          socket.write(
            controlFrame("shell.snapshot.v1", {
              boot_id: "boot-1",
              revision: 1,
            }),
          );
          paint(hello.surface_size.cols, hello.surface_size.rows);
        } else if (variant === 15) {
          reader.string(); // boot_id
          const request = JSON.parse(reader.string());
          const w = new BinWriter();
          w.variant(18);
          w.string("boot-1");
          w.string(request.id);
          w.bool(true);
          w.bytes(Buffer.from(JSON.stringify({ id: request.id, result: {} })));
          socket.write(encodeFrame(w.toBuffer()));
        } else if (variant === 12) {
          reader.varint(); // cell width
          reader.varint(); // cell height
          const cols = reader.varint();
          const rows = reader.varint();
          options.tracker?.events.push("resize");
          paint(cols, rows);
          if (options.clipboardOnResize)
            socket.write(clipboardFrame(options.clipboardOnResize));
        } else if (variant === 13) {
          options.tracker?.events.push("input");
          if (options.clipboardData)
            socket.write(clipboardFrame(options.clipboardData));
        } else if (variant === 17 && reader.variant() === 2) {
          options.tracker?.events.push(
            reader.variant() === 1 ? "theme:light" : "theme:dark",
          );
        } else if (variant === 18) {
          options.tracker?.events.push(reader.bool() ? "focus" : "blur");
        }
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return socketPath;
}

async function waitForTerminalFrame(messages: string[]) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const frame = messages
      .map((message) => JSON.parse(message))
      .find((message) => message.terminal);
    if (frame) return frame.terminal;
    await Bun.sleep(2);
  }
  throw new Error("timed out waiting for terminal frame");
}

async function waitForCondition(
  predicate: () => boolean,
  message: string,
): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(2);
  }
  throw new Error(message);
}

describe("terminal bridge sharing", () => {
  test("a stream reports the colors of the browser that last drove it", async () => {
    const tracker: ServerTracker = { events: [] };
    const socketPath = await startEndpointServer({ tracker });
    const desktop = {} as ServerWebSocket<unknown>;
    const phone = {} as ServerWebSocket<unknown>;
    const bridge = createTerminalBridge({
      clientSocketPath: socketPath,
      lookupPaneId: async () => "p1",
      safeSend: () => true,
      clientLabel: () => "test",
      markRpcError: () => undefined,
    });
    const theme = (appearance: "light" | "dark") => ({
      appearance,
      foreground: appearance === "light" ? "#1f2328" : "#d4d8df",
      background: appearance === "light" ? "#ffffff" : "#0e1014",
      palette: [],
    });
    const events = async (count: number) => {
      for (let i = 0; i < 100 && tracker.events.length < count; i++)
        await Bun.sleep(10);
      const seen = tracker.events.filter((event) => event !== "resize");
      tracker.events.length = 0;
      return seen;
    };
    try {
      await bridge.handleTerminalRpc(
        desktop,
        "theme",
        "terminal.host_theme",
        theme("light"),
      );
      await bridge.handleTerminalRpc(desktop, "attach", "terminal.attach", {
        terminal_id: "t1",
        cols: 100,
        rows: 30,
      });
      expect(await events(2)).toEqual(["hello", "theme:light"]);

      // Another device opening the pane in dark mode does not repaint it.
      await bridge.handleTerminalRpc(
        phone,
        "theme",
        "terminal.host_theme",
        theme("dark"),
      );
      await bridge.handleTerminalRpc(phone, "attach", "terminal.attach", {
        terminal_id: "t1",
        cols: 100,
        rows: 30,
        preserve_size: true,
      });
      await Bun.sleep(50);
      expect(await events(0)).toEqual([]);

      // Typing there hands the stream that device's colors, then back.
      const input = { terminal_id: "t1", data: btoa("x") };
      await bridge.handleTerminalRpc(phone, "input", "terminal.input", input);
      expect(await events(4)).toEqual(["theme:dark", "blur", "focus", "input"]);
      await bridge.handleTerminalRpc(desktop, "input", "terminal.input", input);
      expect(await events(4)).toEqual([
        "theme:light",
        "blur",
        "focus",
        "input",
      ]);

      // The driving device's own switch applies; it leaving hands over.
      await bridge.handleTerminalRpc(
        desktop,
        "theme",
        "terminal.host_theme",
        theme("dark"),
      );
      expect(await events(3)).toEqual(["theme:dark", "blur", "focus"]);
      await bridge.handleTerminalRpc(
        phone,
        "theme",
        "terminal.host_theme",
        theme("light"),
      );
      await Bun.sleep(50);
      expect(await events(0)).toEqual([]);
      bridge.cleanupWs(desktop);
      expect(await events(3)).toEqual(["theme:light", "blur", "focus"]);
    } finally {
      bridge.dispose();
    }
  });

  test("refreshes a reused terminal for a newly attached browser", async () => {
    const socketPath = await startEndpointServer();
    const firstBrowser = {} as ServerWebSocket<unknown>;
    const secondBrowser = {} as ServerWebSocket<unknown>;
    const messages = new Map<ServerWebSocket<unknown>, string[]>([
      [firstBrowser, []],
      [secondBrowser, []],
    ]);
    const bridge = createTerminalBridge({
      clientSocketPath: socketPath,
      lookupPaneId: async () => "p1",
      safeSend: (ws, payload) => {
        messages.get(ws)?.push(payload);
        return true;
      },
      clientLabel: (ws) => (ws === firstBrowser ? "first" : "second"),
      markRpcError: () => undefined,
    });

    await bridge.handleTerminalRpc(
      firstBrowser,
      "first-attach",
      "terminal.attach",
      {
        terminal_id: "term_1",
        cols: 100,
        rows: 30,
      },
    );
    await waitForTerminalFrame(messages.get(firstBrowser)!);

    await bridge.handleTerminalRpc(
      secondBrowser,
      "second-attach",
      "terminal.attach",
      {
        terminal_id: "term_1",
        cols: 100,
        rows: 30,
      },
    );
    const reusedFrame = await waitForTerminalFrame(
      messages.get(secondBrowser)!,
    );

    expect(reusedFrame).toMatchObject({
      terminal_id: "term_1",
      full: true,
      width: 100,
      height: 30,
    });

    const frameCount = messages
      .get(secondBrowser)!
      .map((message) => JSON.parse(message))
      .filter((message) => message.terminal).length;
    await bridge.handleTerminalRpc(
      secondBrowser,
      "duplicate-attach",
      "terminal.attach",
      {
        terminal_id: "term_1",
        cols: 100,
        rows: 30,
      },
    );
    await Bun.sleep(5);
    expect(
      messages
        .get(secondBrowser)!
        .map((message) => JSON.parse(message))
        .filter((message) => message.terminal),
    ).toHaveLength(frameCount);

    bridge.cleanupWs(firstBrowser);
    bridge.cleanupWs(secondBrowser);
  });

  test("notifies viewers to re-attach when Herdr closes the terminal stream", async () => {
    const direct: { socket: net.Socket | null } = { socket: null };
    const socketPath = await startEndpointServer({
      onConnection: (socket) => {
        direct.socket = socket;
      },
    });
    const browser = {} as ServerWebSocket<unknown>;
    const messages: string[] = [];
    const bridge = createTerminalBridge({
      clientSocketPath: socketPath,
      lookupPaneId: async () => "p1",
      safeSend: (ws, payload) => {
        messages.push(payload);
        return true;
      },
      clientLabel: () => "browser",
      markRpcError: () => undefined,
    });

    await bridge.handleTerminalRpc(browser, "attach", "terminal.attach", {
      terminal_id: "term_1",
      cols: 100,
      rows: 30,
    });
    await waitForTerminalFrame(messages);

    // Herdr closes the stream when another client takes the terminal over;
    // the viewer must be told so its UI can re-attach.
    expect(direct.socket).not.toBeNull();
    (direct.socket as net.Socket).destroy();
    await waitForCondition(
      () =>
        messages
          .map((message) => JSON.parse(message))
          .some((message) => message.terminal_closed?.terminal_id === "term_1"),
      "timed out waiting for terminal_closed",
    );
    const closed = messages
      .map((message) => JSON.parse(message))
      .find((message) => message.terminal_closed);
    expect(closed.terminal_closed).toMatchObject({
      terminal_id: "term_1",
      reason: "stream_closed",
    });

    // A re-attach after the close must build a fresh stream.
    messages.length = 0;
    await bridge.handleTerminalRpc(browser, "reattach", "terminal.attach", {
      terminal_id: "term_1",
      cols: 100,
      rows: 30,
    });
    const frame = await waitForTerminalFrame(messages);
    expect(frame).toMatchObject({ terminal_id: "term_1", full: true });

    bridge.cleanupWs(browser);
  });

  test("isolates duplicate terminal ids, operations, frames, and clipboard by connection", async () => {
    const alphaTracker = {
      events: [] as string[],
    };
    const betaTracker = {
      events: [] as string[],
    };
    const [alphaSocket, betaSocket] = await Promise.all([
      startEndpointServer({
        tracker: alphaTracker,
        clipboardData: "YWxwaGE=",
      }),
      startEndpointServer({
        tracker: betaTracker,
        clipboardData: "YmV0YQ==",
      }),
    ]);
    const browser = {} as ServerWebSocket<unknown>;
    const alphaMessages: string[] = [];
    const betaMessages: string[] = [];
    const alphaBridge = createTerminalBridge({
      connectionId: "alpha",
      connectionGeneration: 11,
      clientSocketPath: alphaSocket,
      lookupPaneId: async () => "p1",
      safeSend: (_ws, payload) => {
        alphaMessages.push(payload);
        return true;
      },
      clientLabel: () => "browser",
      markRpcError: () => undefined,
    });
    const betaBridge = createTerminalBridge({
      connectionId: "beta",
      connectionGeneration: 12,
      clientSocketPath: betaSocket,
      lookupPaneId: async () => "p1",
      safeSend: (_ws, payload) => {
        betaMessages.push(payload);
        return true;
      },
      clientLabel: () => "browser",
      markRpcError: () => undefined,
    });

    await Promise.all([
      alphaBridge.handleTerminalRpc(
        browser,
        "alpha-attach",
        "terminal.attach",
        {
          terminal_id: "same-terminal",
          cols: 100,
          rows: 30,
        },
      ),
      betaBridge.handleTerminalRpc(browser, "beta-attach", "terminal.attach", {
        terminal_id: "same-terminal",
        cols: 100,
        rows: 30,
      }),
    ]);
    await Promise.all([
      waitForTerminalFrame(alphaMessages),
      waitForTerminalFrame(betaMessages),
    ]);

    expect(
      alphaMessages.every((message) => {
        const parsed = JSON.parse(message);
        return (
          parsed.connection_id === "alpha" &&
          parsed.connection_generation === 11
        );
      }),
    ).toBe(true);
    expect(
      betaMessages.every((message) => {
        const parsed = JSON.parse(message);
        return (
          parsed.connection_id === "beta" && parsed.connection_generation === 12
        );
      }),
    ).toBe(true);

    await alphaBridge.handleTerminalRpc(
      browser,
      "alpha-input",
      "terminal.input",
      {
        terminal_id: "same-terminal",
        data: Buffer.from("copy").toString("base64"),
      },
    );
    await alphaBridge.handleTerminalRpc(
      browser,
      "alpha-scroll",
      "terminal.scroll",
      {
        terminal_id: "same-terminal",
        direction: "up",
        lines: 10,
        source: "page-key",
      },
    );
    await betaBridge.handleTerminalRpc(
      browser,
      "beta-resize",
      "terminal.resize",
      {
        terminal_id: "same-terminal",
        cols: 120,
        rows: 40,
      },
    );

    await waitForCondition(
      () =>
        alphaTracker.events.filter((event) => event === "input").length === 2 &&
        betaTracker.events.includes("resize") &&
        alphaMessages.some((message) => JSON.parse(message).terminal_clipboard),
      "timed out waiting for isolated terminal operations",
    );
    // Typing and page keys both reach alpha's pane as input.
    expect(alphaTracker.events).not.toContain("resize");
    expect(betaTracker.events).toContain("resize");
    expect(betaTracker.events).not.toContain("input");
    expect(
      alphaMessages
        .map((message) => JSON.parse(message))
        .find((message) => message.terminal_clipboard),
    ).toMatchObject({
      connection_id: "alpha",
      connection_generation: 11,
      terminal_clipboard: {
        terminal_id: "same-terminal",
        data: "YWxwaGE=",
      },
    });
    expect(
      betaMessages.some((message) => JSON.parse(message).terminal_clipboard),
    ).toBe(false);

    alphaBridge.dispose();
    betaBridge.dispose();
  });

  test("does not broadcast clipboard events without a matching input owner", async () => {
    const socketPath = await startEndpointServer({
      clipboardOnResize: "bm8gb3duZXI=",
    });
    const firstBrowser = {} as ServerWebSocket<unknown>;
    const secondBrowser = {} as ServerWebSocket<unknown>;
    const messages = new Map<ServerWebSocket<unknown>, string[]>([
      [firstBrowser, []],
      [secondBrowser, []],
    ]);
    const bridge = createTerminalBridge({
      clientSocketPath: socketPath,
      lookupPaneId: async () => "p1",
      safeSend: (ws, payload) => {
        messages.get(ws)?.push(payload);
        return true;
      },
      clientLabel: () => "browser",
      markRpcError: () => undefined,
    });

    await bridge.handleTerminalRpc(
      firstBrowser,
      "attach-1",
      "terminal.attach",
      {
        terminal_id: "term_1",
        cols: 100,
        rows: 30,
      },
    );
    await bridge.handleTerminalRpc(
      secondBrowser,
      "attach-2",
      "terminal.attach",
      {
        terminal_id: "term_1",
        cols: 100,
        rows: 30,
      },
    );
    await Bun.sleep(5);

    for (const sent of messages.values()) {
      expect(
        sent.some((message) => JSON.parse(message).terminal_clipboard),
      ).toBe(false);
    }
    bridge.cleanupWs(firstBrowser);
    bridge.cleanupWs(secondBrowser);
  });

  test("rejects input for terminals the browser does not view", async () => {
    const socketPath = await startEndpointServer();
    const owner = {} as ServerWebSocket<unknown>;
    const stranger = {} as ServerWebSocket<unknown>;
    const messages = new Map<ServerWebSocket<unknown>, string[]>([
      [owner, []],
      [stranger, []],
    ]);
    const bridge = createTerminalBridge({
      clientSocketPath: socketPath,
      lookupPaneId: async () => "p1",
      safeSend: (ws, payload) => {
        messages.get(ws)?.push(payload);
        return true;
      },
      clientLabel: () => "browser",
      markRpcError: () => undefined,
    });
    await bridge.handleTerminalRpc(owner, "attach", "terminal.attach", {
      terminal_id: "term_1",
      cols: 100,
      rows: 30,
    });

    await bridge.handleTerminalRpc(stranger, "input", "terminal.input", {
      terminal_id: "term_1",
      data: Buffer.from("steal clipboard").toString("base64"),
    });

    expect(
      messages
        .get(stranger)!
        .map((message) => JSON.parse(message))
        .find((message) => message.id === "input")?.error.message,
    ).toBe("no terminal attached");
    bridge.cleanupWs(owner);
    bridge.cleanupWs(stranger);
  });

  test("dispose closes runtime-owned terminal resources", async () => {
    const tracker = {
      events: [] as string[],
    };
    const socketPath = await startEndpointServer({ tracker });
    const browser = {} as ServerWebSocket<unknown>;
    const messages: string[] = [];
    const bridge = createTerminalBridge({
      clientSocketPath: socketPath,
      lookupPaneId: async () => "p1",
      safeSend: (_ws, payload) => {
        messages.push(payload);
        return true;
      },
      clientLabel: () => "browser",
      markRpcError: () => undefined,
    });

    await bridge.handleTerminalRpc(browser, "attach", "terminal.attach", {
      terminal_id: "term_dispose",
      cols: 100,
      rows: 30,
    });
    expect(bridge.statusTerminals()).toEqual([
      { terminal_id: "term_dispose", viewers: 1 },
    ]);

    bridge.dispose();
    bridge.dispose();
    await bridge.handleTerminalRpc(
      browser,
      "after-dispose",
      "terminal.attach",
      {
        terminal_id: "term_after_dispose",
        cols: 100,
        rows: 30,
      },
    );

    expect(bridge.statusTerminals()).toEqual([]);
    expect(bridge.viewedTerminals(browser)).toEqual([]);
    expect(
      messages
        .map((message) => JSON.parse(message))
        .find((message) => message.id === "after-dispose")?.error.message,
    ).toBe("terminal bridge disposed");
    await waitForCondition(
      () => serverConnections.size === 0,
      "timed out waiting for the endpoint stream to close",
    );
  });

  test("dispose wins an in-flight attach without retaining resources", async () => {
    const tracker = {
      events: [] as string[],
    };
    const socketPath = await startEndpointServer({
      tracker,
      skipSurface: true,
    });
    const browser = {} as ServerWebSocket<unknown>;
    const messages: string[] = [];
    const bridge = createTerminalBridge({
      clientSocketPath: socketPath,
      lookupPaneId: async () => "p1",
      safeSend: (_ws, payload) => {
        messages.push(payload);
        return true;
      },
      clientLabel: () => "browser",
      markRpcError: () => undefined,
    });

    const attaching = bridge.handleTerminalRpc(
      browser,
      "concurrent-attach",
      "terminal.attach",
      {
        terminal_id: "term_concurrent_dispose",
        cols: 100,
        rows: 30,
      },
    );
    await waitForCondition(
      () => tracker.events.includes("hello"),
      "timed out waiting for the endpoint hello",
    );
    bridge.dispose();
    await attaching;

    expect(bridge.statusTerminals()).toEqual([]);
    expect(bridge.viewedTerminals(browser)).toEqual([]);
    // Which layer reports the close depends on whether the client had already
    // finished its handshake or sent its surface request when dispose closed it; both mean dispose won.
    expect(
      messages
        .map((message) => JSON.parse(message))
        .find((message) => message.id === "concurrent-attach")?.error.message,
    ).toMatch(/^endpoint (client|connection) closed/);
  });

  test("suppresses terminal replies after the request lease is invalidated", async () => {
    const messages: string[] = [];
    const bridge = createTerminalBridge({
      connectionId: "alpha",
      clientSocketPath: "/tmp/unused-terminal-lease.sock",
      lookupPaneId: async () => "p1",
      safeSend: (_ws, payload) => {
        messages.push(payload);
        return true;
      },
      clientLabel: () => "browser",
      markRpcError: () => undefined,
    });

    await bridge.handleTerminalRpc(
      {} as ServerWebSocket<unknown>,
      "stale-terminal",
      "terminal.input",
      { terminal_id: "same", data: "YQ==" },
      () => false,
    );

    expect(messages.map((message) => JSON.parse(message))).toEqual([
      {
        connection_id: "alpha",
        id: "stale-terminal",
        error: { message: "connection changed during request" },
      },
    ]);
    bridge.dispose();
  });
});

// A held frame is sized for the surface it was rendered against. If the surface
// resizes while that frame is held, flushing it paints the OLD size into the new
// pane, clipping the bottom and right. The bridge must drop the held frame
// whenever the size it was rendered for stops being current.
test("drops a held frame when the viewer resizes the terminal", async () => {
  const socketPath = await startEndpointServer();
  const browser = {} as ServerWebSocket<unknown>;
  const messages: string[] = [];
  const drops: { ws: ServerWebSocket<unknown>; coalesceKey: string }[] = [];
  const bridge = createTerminalBridge({
    clientSocketPath: socketPath,
    lookupPaneId: async () => "p1",
    safeSend: (_ws, payload) => {
      messages.push(payload);
      return true;
    },
    dropCoalesced: (ws, coalesceKey) => drops.push({ ws, coalesceKey }),
    clientLabel: () => "test",
    markRpcError: () => undefined,
  });
  try {
    await bridge.handleTerminalRpc(browser, "attach", "terminal.attach", {
      terminal_id: "term_1",
      cols: 100,
      rows: 30,
    });
    await waitForTerminalFrame(messages);
    drops.length = 0;
    await bridge.handleTerminalRpc(browser, "resize", "terminal.resize", {
      terminal_id: "term_1",
      cols: 120,
      rows: 40,
    });
    expect(drops).toEqual([
      { ws: browser, coalesceKey: 'terminal:[null,null,"term_1"]' },
    ]);
  } finally {
    bridge.dispose();
  }
});

test("drops held frames for every viewer when an attach resizes the shared terminal", async () => {
  const socketPath = await startEndpointServer();
  const first = {} as ServerWebSocket<unknown>;
  const second = {} as ServerWebSocket<unknown>;
  const messages: string[] = [];
  const drops: { ws: ServerWebSocket<unknown>; coalesceKey: string }[] = [];
  const bridge = createTerminalBridge({
    clientSocketPath: socketPath,
    lookupPaneId: async () => "p1",
    safeSend: (_ws, payload) => {
      messages.push(payload);
      return true;
    },
    dropCoalesced: (ws, coalesceKey) => drops.push({ ws, coalesceKey }),
    clientLabel: () => "test",
    markRpcError: () => undefined,
  });
  try {
    await bridge.handleTerminalRpc(first, "a1", "terminal.attach", {
      terminal_id: "term_1",
      cols: 100,
      rows: 30,
    });
    await waitForTerminalFrame(messages);
    drops.length = 0;
    // A different size resizes the shared terminal, so the frame the FIRST
    // viewer is holding is now the wrong size for it too.
    await bridge.handleTerminalRpc(second, "a2", "terminal.attach", {
      terminal_id: "term_1",
      cols: 140,
      rows: 50,
    });
    expect(drops.map((d) => d.ws)).toContain(first);
    expect(
      drops.every((d) => d.coalesceKey === 'terminal:[null,null,"term_1"]'),
    ).toBe(true);
  } finally {
    bridge.dispose();
  }
});

/**
 * A bridge whose endpoint sessions never open a socket: `connect` and `resize`
 * are recorded, and the test emits the session's frames itself.
 */
function offlineBridge(
  options: Partial<Parameters<typeof createTerminalBridge>[0]> = {},
) {
  const sessions: EndpointTerminalSession[] = [];
  const connects: unknown[][] = [];
  const resizes: unknown[][] = [];
  const connect = spyOn(
    EndpointTerminalSession.prototype,
    "connect",
  ).mockImplementation(function (
    this: EndpointTerminalSession,
    ...size: unknown[]
  ) {
    sessions.push(this);
    connects.push(size);
    return Promise.resolve();
  });
  const resize = spyOn(
    EndpointTerminalSession.prototype,
    "resize",
  ).mockImplementation((...size: unknown[]) => {
    resizes.push(size);
  });
  const messages = new Map<ServerWebSocket<unknown>, any[]>();
  const bridge = createTerminalBridge({
    clientSocketPath: "/nonexistent",
    lookupPaneId: async () => "p1",
    safeSend: (ws, payload) => {
      const inbox = messages.get(ws) ?? [];
      messages.set(ws, inbox);
      inbox.push(payload);
      return true;
    },
    clientLabel: () => "test",
    markRpcError: () => {},
    ...options,
  });
  const call = async (
    ws: ServerWebSocket<unknown>,
    method: string,
    params: Record<string, unknown>,
  ) => {
    const id = crypto.randomUUID();
    await bridge.handleTerminalRpc(ws, id, method, params);
    const reply = (messages.get(ws) ?? [])
      .map((line) => JSON.parse(line))
      .find((line) => line.id === id);
    if (reply?.error) throw new Error(reply.error.message);
    return reply?.result;
  };
  return {
    bridge,
    call,
    connects,
    resizes,
    sessions,
    frames: (ws: ServerWebSocket<unknown>) =>
      (messages.get(ws) ?? []).filter((line) => line.includes('"terminal":')),
    clear: () => messages.clear(),
    restore: () => {
      bridge.dispose();
      connect.mockRestore();
      resize.mockRestore();
    },
  };
}

describe("terminal size validation", () => {
  test("attach and resize use whole cells within bounds", async () => {
    const harness = offlineBridge();
    const browser = {} as ServerWebSocket<unknown>;
    try {
      await harness.call(browser, "terminal.attach", {
        terminal_id: "t1",
        cols: 80.6,
        rows: 24.2,
      });
      expect(harness.connects).toEqual([[80, 24, undefined]]);
      await harness.call(browser, "terminal.resize", {
        terminal_id: "t1",
        cols: 1e9,
        rows: -5,
      });
      expect(harness.resizes.at(-1)).toEqual([TERMINAL_MAX_COLS, 1]);
      await harness.call(browser, "terminal.resize", {
        terminal_id: "t1",
        cols: 0.5,
        rows: 30.999,
      });
      expect(harness.resizes.at(-1)).toEqual([1, 30]);
      await expect(
        harness.call(browser, "terminal.resize", {
          terminal_id: "t1",
          cols: "80",
          rows: 24,
        }),
      ).rejects.toThrow("cols must be a finite number");
    } finally {
      harness.restore();
    }
  });
});

describe("terminal frame fanout", () => {
  const frame: FrameData = {
    cells: Array.from({ length: 18 }, (_, i) =>
      cell(i === 7 ? "界" : String.fromCharCode(97 + i)),
    ),
    width: 6,
    height: 3,
    cursor: { x: 1, y: 1, visible: true, shape: 1 },
    hyperlinks: [],
  };
  const event = (withParts: boolean) => ({
    linkFrame: "session:1",
    seq: 1,
    width: frame.width,
    height: frame.height,
    full: true,
    mouseReporting: false,
    history: undefined,
    bytes: Buffer.from(frameToAnsi(frame), "utf8"),
    ...(withParts ? { parts: frameToAnsiParts(frame) } : {}),
    frame,
  });

  async function fanout() {
    const harness = offlineBridge();
    const full = {} as ServerWebSocket<unknown>;
    const fullDelta = {} as ServerWebSocket<unknown>;
    const clipped = {} as ServerWebSocket<unknown>;
    const clippedDelta = {} as ServerWebSocket<unknown>;
    // The small viewers attach first, so their viewports stay 4x2 when the
    // large ones resize the shared stream to 6x3.
    for (const [ws, cols, rows, delta] of [
      [clipped, 4, 2, false],
      [clippedDelta, 4, 2, true],
      [full, 6, 3, false],
      [fullDelta, 6, 3, true],
    ] as const)
      await harness.call(ws, "terminal.attach", {
        terminal_id: "t1",
        cols,
        rows,
        ...(delta ? { frame_delta: true } : {}),
      });
    harness.clear();
    return { harness, full, fullDelta, clipped, clippedDelta };
  }

  const repaint = (bytes: string, width: number, height: number) => ({
    terminal: {
      terminal_id: "t1",
      width,
      height,
      full: true,
      link_frame: "session:1",
      mouse_reporting: false,
      bytes: Buffer.from(bytes).toString("base64"),
    },
  });
  const rowsFrame = (
    parts: ReturnType<typeof frameToAnsiParts>,
    width: number,
    height: number,
  ) => ({
    terminal: {
      terminal_id: "t1",
      width,
      height,
      full: true,
      link_frame: "session:1",
      mouse_reporting: false,
      frame_seq: expect.any(Number),
      rows: parts.rows,
      tail: parts.tail,
    },
  });

  test.each([
    ["the session's shared rows", true],
    ["no rows from the session", false],
  ])(
    "every viewer receives the bytes a per-viewer encode would produce, given %s",
    async (_name, withParts) => {
      const { harness, full, fullDelta, clipped, clippedDelta } =
        await fanout();
      const small = { cols: 4, rows: 2 };
      try {
        harness.sessions[0].emit("terminal", event(withParts));
        // Full repaints are compared as text: the wire bytes themselves.
        expect(harness.frames(full)).toEqual([
          JSON.stringify(repaint(frameToAnsi(frame), 6, 3)),
        ]);
        expect(harness.frames(clipped)).toEqual([
          JSON.stringify(repaint(frameToAnsi(frame, small), 4, 2)),
        ]);
        // Row streams number their frames, so compare everything else.
        expect(
          harness.frames(fullDelta).map((line) => JSON.parse(line)),
        ).toEqual([rowsFrame(frameToAnsiParts(frame), 6, 3)]);
        expect(
          harness.frames(clippedDelta).map((line) => JSON.parse(line)),
        ).toEqual([rowsFrame(frameToAnsiParts(frame, small), 4, 2)]);
      } finally {
        harness.restore();
      }
    },
  );

  test("a frame is encoded once per distinct size, not once per viewer or form", async () => {
    const { harness } = await fanout();
    // The encoder measures each cell it writes exactly once.
    const withRows = event(true);
    const withoutRows = event(false);
    // The encoder measures each cell it writes exactly once: 17 for the whole
    // 6x3 frame (one cell is the second half of a wide character), 7 for the
    // 4x2 clip.
    const measured = spyOn(Bun, "stringWidth");
    try {
      harness.sessions[0].emit("terminal", withRows);
      // Four viewers, two output forms: only the clipped size is encoded
      // here; the full size reuses the session's rows. Before, this fanout
      // encoded 17 + 7 + 7 cells on top of the session's own 17.
      expect(measured).toHaveBeenCalledTimes(7);
      measured.mockClear();
      // A session that supplies no rows costs one more encode, still shared.
      harness.sessions[0].emit("terminal", withoutRows);
      expect(measured).toHaveBeenCalledTimes(17 + 7);
    } finally {
      measured.mockRestore();
      harness.restore();
    }
  });

  test("a viewer whose frame cannot be sent does not stop the others", async () => {
    const sent: ServerWebSocket<unknown>[] = [];
    const broken = {} as ServerWebSocket<unknown>;
    const healthy = {} as ServerWebSocket<unknown>;
    let failing = false;
    const harness = offlineBridge({
      safeSend: (ws) => {
        if (failing && ws === broken) throw new TypeError("bad viewport");
        sent.push(ws);
        return true;
      },
    });
    try {
      for (const ws of [broken, healthy])
        await harness.bridge.handleTerminalRpc(ws, "a", "terminal.attach", {
          terminal_id: "t1",
          cols: 6,
          rows: 3,
        });
      sent.length = 0;
      failing = true;
      expect(() =>
        harness.sessions[0].emit("terminal", event(true)),
      ).not.toThrow();
      expect(sent).toEqual([healthy]);
      expect(harness.bridge.statusTerminals()).toEqual([
        { terminal_id: "t1", viewers: 2 },
      ]);
    } finally {
      harness.restore();
    }
  });
});

describe("remembered terminal facts", () => {
  function tracked() {
    const lookups = new Map<string, number>();
    const display = createDisplayOwnership();
    // Pane lookups are remembered only while some pane has a display owner.
    display.claim(
      "elsewhere",
      { participantId: "web-other", deviceKey: "device:other" },
      true,
    );
    let panes: { paneId: string; terminalId: string }[] = [];
    const harness = offlineBridge({
      displayOwnership: display,
      lookupPaneId: async (terminalId) => {
        lookups.set(terminalId, (lookups.get(terminalId) ?? 0) + 1);
        return `pane-of-${terminalId}`;
      },
      listPaneTerminals: async () => panes,
    });
    const browser = {} as ServerWebSocket<unknown>;
    const visit = async (terminalId: string, detach = true) => {
      await harness.call(browser, "terminal.attach", {
        terminal_id: terminalId,
        cols: 80,
        rows: 24,
      });
      if (detach)
        await harness.call(browser, "terminal.detach", {
          terminal_id: terminalId,
        });
    };
    return {
      harness,
      lookups,
      visit,
      setPanes: (next: typeof panes) => {
        panes = next;
      },
    };
  }

  test("forgets the oldest unviewed terminals past the limit", async () => {
    const { harness, lookups, visit } = tracked();
    try {
      for (let i = 0; i <= TERMINAL_FACT_LIMIT; i++) await visit(`t${i}`);
      await visit(`t${TERMINAL_FACT_LIMIT}`);
      expect(lookups.get(`t${TERMINAL_FACT_LIMIT}`)).toBe(1);
      await visit("t0");
      expect(lookups.get("t0")).toBe(2);
    } finally {
      harness.restore();
    }
  });

  test("forgets a closed pane's terminal unless it is being viewed", async () => {
    const { harness, lookups, visit } = tracked();
    try {
      await visit("closed");
      await visit("viewed", false);
      harness.bridge.forgetPane("pane-of-closed");
      harness.bridge.forgetPane("pane-of-viewed");
      await visit("closed");
      await visit("viewed");
      expect(lookups.get("closed")).toBe(2);
      expect(lookups.get("viewed")).toBe(1);
    } finally {
      harness.restore();
    }
  });

  test("reconciling drops terminals Herdr no longer lists", async () => {
    const { harness, lookups, visit, setPanes } = tracked();
    try {
      await visit("kept");
      await visit("dropped");
      setPanes([{ paneId: "pane-of-kept", terminalId: "kept" }]);
      await harness.bridge.reconcileTerminals("test");
      await visit("kept");
      await visit("dropped");
      expect(lookups.get("kept")).toBe(1);
      expect(lookups.get("dropped")).toBe(2);
    } finally {
      harness.restore();
    }
  });
});

describe("terminal input and frame acknowledgement", () => {
  async function attached(frameDelta = false) {
    const socketPath = await startEndpointServer();
    const browser = {} as ServerWebSocket<unknown>;
    const messages: string[] = [];
    const bridge = createTerminalBridge({
      clientSocketPath: socketPath,
      lookupPaneId: async () => "p1",
      safeSend: (_ws, payload) => {
        messages.push(payload);
        return true;
      },
      clientLabel: () => "test",
      markRpcError: () => undefined,
    });
    await bridge.handleTerminalRpc(browser, "attach", "terminal.attach", {
      terminal_id: "term_1",
      cols: 100,
      rows: 30,
      ...(frameDelta ? { frame_delta: true } : {}),
    });
    const frame = await waitForTerminalFrame(messages);
    const replies = () =>
      messages
        .map((message) => JSON.parse(message))
        .filter((message) => message.id !== undefined);
    return { bridge, browser, messages, frame, replies };
  }

  test("input to a ready terminal is written before the handler yields", async () => {
    const { bridge, browser, messages, replies } = await attached();
    try {
      messages.length = 0;
      const first = bridge.handleTerminalRpc(browser, "a", "terminal.input", {
        terminal_id: "term_1",
        data: btoa("a"),
      });
      // No await yet: the reply follows the write, so both already happened.
      expect(replies()).toEqual([{ id: "a", result: { ok: true } }]);
      const second = bridge.handleTerminalRpc(browser, "b", "terminal.key", {
        terminal_id: "term_1",
        keys: [{ key: "Enter", mods: 0 }],
      });
      expect(replies().map((reply) => reply.id)).toEqual(["a", "b"]);
      await Promise.all([first, second]);
    } finally {
      bridge.dispose();
    }
  });

  test("a frame is acknowledged one-way, and by request for older pages", async () => {
    const { bridge, browser, messages, frame, replies } = await attached(true);
    try {
      expect(frame.frame_seq).toEqual(expect.any(Number));
      messages.length = 0;
      expect(
        bridge.acknowledgeFrame(browser, "term_1", { seq: frame.frame_seq }),
      ).toBe(true);
      // Nothing is sent back for the one-way form.
      expect(replies()).toEqual([]);
      // A socket without that stream is ignored, also silently.
      expect(
        bridge.acknowledgeFrame({} as ServerWebSocket<unknown>, "term_1", {
          seq: frame.frame_seq,
        }),
      ).toBe(false);
      expect(bridge.acknowledgeFrame(browser, null, { seq: 1 })).toBe(false);
      expect(replies()).toEqual([]);

      await bridge.handleTerminalRpc(browser, "ack", "terminal.frame_ack", {
        terminal_id: "term_1",
        seq: frame.frame_seq,
      });
      expect(replies()).toEqual([{ id: "ack", result: { ok: true } }]);

      // A resync request restarts the stream from a full frame.
      messages.length = 0;
      expect(bridge.acknowledgeFrame(browser, "term_1", { resync: true })).toBe(
        true,
      );
      expect((await waitForTerminalFrame(messages)).full).toBe(true);
    } finally {
      bridge.dispose();
    }
  });
});
