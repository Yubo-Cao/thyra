// The headed Chromium agents drive, seen from Thyra: its VNC display (a Unix
// socket bridged to a browser WebSocket) and the web-access CDP proxy that
// records which pane owns each tab and when an agent hands one over.
import { statSync } from "node:fs";
import { join } from "node:path";
import type { Socket } from "bun";
import { thyraEnv } from "../config/environment";
import type { Logger } from "../utils/logger";

export type BrowserReview = { state: string; message?: string };
export type BrowserTab = {
  targetId: string;
  url: string;
  title: string;
  review?: BrowserReview;
};
/** A browser window, shown by its front tab; fronting that tab raises it. */
export type BrowserWindow = {
  targetId: string;
  url: string;
  title: string;
  tabs: number;
};
export type BrowserOwner = { paneId: string; workspaceId?: string };
export type ReviewRequest = {
  targetId: string;
  owner: BrowserOwner;
  message: string;
  url: string;
  title: string;
};
/** The few WebSocket methods the VNC bridge uses. */
export type VncPeer = {
  send(data: Uint8Array): unknown;
  close(code?: number, reason?: string): void;
};

export function agentBrowserConfig(env = process.env) {
  const runtime = env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.()}`;
  return {
    vncSocket:
      thyraEnv("BROWSER_VNC_SOCKET", env) ||
      join(runtime, "chromium-virtual-display", "vnc.sock"),
    proxyUrl: (
      thyraEnv("BROWSER_PROXY_URL", env) || "http://127.0.0.1:3456"
    ).replace(/\/+$/, ""),
    /** Run with 1 or 2 to set the display's device scale (HiDPI viewers). */
    scaleCommand: thyraEnv("BROWSER_SCALE_COMMAND", env) || undefined,
  };
}

const text = (value: unknown, max = 2048) =>
  typeof value === "string" ? value.slice(0, max) : "";

function parseReview(value: unknown): BrowserReview | undefined {
  const review = value as { state?: unknown; message?: unknown } | null;
  if (!review || typeof review.state !== "string") return undefined;
  return { state: text(review.state, 32), message: text(review.message, 500) };
}

function parseTab(value: unknown): BrowserTab | null {
  const tab = value as Record<string, unknown> | null;
  if (!tab || typeof tab.targetId !== "string" || !tab.targetId) return null;
  const review = parseReview(tab.review);
  return {
    targetId: text(tab.targetId, 128),
    url: text(tab.url),
    title: text(tab.title, 300),
    ...(review ? { review } : {}),
  };
}

/** Pending review first (the latest), else the most recently listed tab. */
export function relevantTab(tabs: BrowserTab[]): BrowserTab | undefined {
  return tabs.findLast((tab) => tab.review?.state === "pending") ?? tabs.at(-1);
}

/** Feed SSE text; returns the `data` payloads of completed events. */
export function createSseParser() {
  let buffer = "";
  return (chunk: string): string[] => {
    buffer += chunk.replace(/\r\n?/g, "\n");
    const events: string[] = [];
    let end: number;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""));
      if (data.length) events.push(data.join("\n"));
    }
    if (buffer.length > 1 << 20) buffer = "";
    return events;
  };
}

export function createAgentBrowser(options: {
  vncSocket: string;
  proxyUrl: string;
  logger: Logger;
  onReview: (request: ReviewRequest) => void;
  scaleCommand?: string;
  /** Runs the scale command; resolves when it exits. */
  runScale?: (command: string, scale: number) => Promise<unknown>;
  fetch?: typeof fetch;
  connect?: typeof Bun.connect;
  backoffMs?: (attempt: number) => number;
}) {
  const fetchProxy = options.fetch ?? fetch;
  const connect = options.connect ?? Bun.connect;
  const backoff =
    options.backoffMs ?? ((attempt) => Math.min(30_000, 1000 * 2 ** attempt));
  const { logger } = options;
  // Last review state seen per tab, so a repeated event is quiet. The proxy
  // never replays, so a new stream starts afresh.
  const reviews = new Map<string, string>();
  let events: AbortController | null = null;
  let proxyUp = false;

  // Device scale each open viewer asked for. The display runs at the largest
  // while any viewer is open and returns to 1 after the last one closes, so
  // agents' own screenshots stay at 1x.
  const viewerScales = new Map<object, number>();
  let appliedScale = 1;
  let scaling: Promise<unknown> = Promise.resolve();
  const runScale =
    options.runScale ??
    ((command: string, scale: number) =>
      Bun.spawn([command, String(scale)], {
        stdout: "ignore",
        stderr: "ignore",
      }).exited);
  function applyScale() {
    const command = options.scaleCommand;
    if (!command) return;
    scaling = scaling.then(async () => {
      const scale = Math.max(1, ...viewerScales.values());
      if (scale === appliedScale) return;
      try {
        await runScale(command, scale);
        appliedScale = scale;
      } catch (error) {
        logger.debug("browser scale command failed", {
          error: (error as Error).message,
        });
      }
    });
  }

  function vncAvailable() {
    try {
      return statSync(options.vncSocket).isSocket();
    } catch {
      return false;
    }
  }

  /** The pane's tabs, or every tab in the browser when `paneId` is null. */
  async function tabs(paneId: string | null): Promise<BrowserTab[] | null> {
    const query = paneId ? `?pane=${encodeURIComponent(paneId)}` : "";
    try {
      const response = await fetchProxy(
        `${options.proxyUrl}/targets${query}`,
        { signal: AbortSignal.timeout(3000), redirect: "error" },
      );
      if (!response.ok) return null;
      const listed: unknown = await response.json();
      return Array.isArray(listed)
        ? listed.flatMap((tab) => parseTab(tab) ?? []).slice(0, 100)
        : null;
    } catch {
      return null;
    }
  }

  /** Every browser window, the one with the most tabs first. */
  async function windows(): Promise<BrowserWindow[] | null> {
    try {
      const response = await fetchProxy(`${options.proxyUrl}/contexts`, {
        signal: AbortSignal.timeout(3000),
        redirect: "error",
      });
      if (!response.ok) return null;
      const listed = (await response.json()) as {
        contexts?: { windows?: unknown[] }[];
      };
      const found: BrowserWindow[] = [];
      for (const context of listed?.contexts ?? [])
        for (const raw of context?.windows ?? []) {
          const window = raw as {
            activeTargetId?: unknown;
            anchorTargetId?: unknown;
            tabs?: unknown[];
          };
          const tabs = (Array.isArray(window.tabs) ? window.tabs : []).flatMap(
            (tab) => parseTab(tab) ?? [],
          );
          const front =
            tabs.find((tab) => tab.targetId === window.activeTargetId) ??
            tabs.find((tab) => tab.targetId === window.anchorTargetId) ??
            tabs[0];
          if (front)
            found.push({
              targetId: front.targetId,
              url: front.url,
              title: front.title,
              tabs: tabs.length,
            });
        }
      return found.sort((a, b) => b.tabs - a.tabs).slice(0, 100);
    } catch {
      return null;
    }
  }

  /**
   * Bring `targetId` (or the pane's most relevant tab) to the front. Without a
   * pane any open tab may be fronted. Only fronts: never closes another tab.
   */
  async function activate(paneId: string | null, targetId?: string | null) {
    if (!paneId && !targetId) return null;
    const listed = (await tabs(paneId)) ?? [];
    const tab = targetId
      ? listed.find((entry) => entry.targetId === targetId)
      : relevantTab(listed);
    if (!tab) return null;
    try {
      const response = await fetchProxy(
        `${options.proxyUrl}/activate?target=${encodeURIComponent(tab.targetId)}`,
        {
          method: "POST",
          signal: AbortSignal.timeout(3000),
          redirect: "error",
        },
      );
      await response.body?.cancel();
      return response.ok ? tab.targetId : null;
    } catch {
      return null;
    }
  }

  function observe(raw: string) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(raw);
    } catch {
      return;
    }
    const targetId = text(event?.targetId, 128);
    if (!targetId) return;
    if (event.type === "closed") {
      reviews.delete(targetId);
      return;
    }
    const review = parseReview(event.review);
    if (!review) return;
    const key = `${review.state}\n${review.message ?? ""}`;
    if (reviews.get(targetId) === key) return;
    reviews.set(targetId, key);
    if (reviews.size > 1000) reviews.delete(reviews.keys().next().value!);
    const owner = event.owner as Record<string, unknown> | null;
    if (review.state !== "pending" || typeof owner?.paneId !== "string") return;
    options.onReview({
      targetId,
      owner: {
        paneId: text(owner.paneId, 128),
        workspaceId: text(owner.workspaceId, 128) || undefined,
      },
      message: review.message ?? "",
      url: text(event.url),
      title: text(event.title, 300),
    });
  }

  async function subscribe(signal: AbortSignal) {
    for (let attempt = 0; !signal.aborted; ) {
      try {
        const response = await fetchProxy(`${options.proxyUrl}/events`, {
          headers: { accept: "text/event-stream" },
          signal,
          redirect: "error",
        });
        if (!response.ok || !response.body)
          throw new Error(`HTTP ${response.status}`);
        if (!proxyUp) logger.info("browser proxy events connected");
        proxyUp = true;
        attempt = 0;
        reviews.clear();
        const parse = createSseParser();
        const decoder = new TextDecoder();
        for await (const chunk of response.body)
          for (const data of parse(decoder.decode(chunk, { stream: true })))
            observe(data);
      } catch (error) {
        if (signal.aborted) return;
        if (proxyUp)
          logger.debug("browser proxy events lost", {
            error: (error as Error).message,
          });
        proxyUp = false;
      }
      if (signal.aborted) return;
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, backoff(attempt++));
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve(undefined);
        });
      });
    }
  }

  /**
   * One VNC socket connection per peer; either end closing closes both.
   * `scale` 2 asks for a HiDPI display while this peer is open.
   */
  function openVnc(peer: VncPeer, scale = 1) {
    let socket: Socket<undefined> | null = null;
    let closed = false;
    const queued: Uint8Array[] = [];
    const flush = () => {
      while (socket && queued.length) {
        const chunk = queued[0]!;
        const written = socket.write(chunk);
        if (written < chunk.length) {
          queued[0] = chunk.subarray(Math.max(0, written));
          return;
        }
        queued.shift();
      }
    };
    const release = () => {
      if (viewerScales.delete(peer)) applyScale();
    };
    const close = () => {
      release();
      if (closed) return;
      closed = true;
      socket?.end();
      peer.close(1000, "VNC closed");
    };
    if (!vncAvailable()) {
      peer.close(4404, "VNC display unavailable");
      return { message() {}, close() {} };
    }
    if (options.scaleCommand) {
      viewerScales.set(peer, scale === 2 ? 2 : 1);
      applyScale();
    }
    connect({
      unix: options.vncSocket,
      socket: {
        open(opened) {
          if (closed) return void opened.end();
          socket = opened;
          flush();
        },
        data(_socket, data) {
          if (!closed) peer.send(data);
        },
        drain: flush,
        close,
        error: close,
      },
    }).catch(() => {
      release();
      if (!closed) peer.close(4404, "VNC display unavailable");
      closed = true;
    });
    return {
      message(data: Uint8Array) {
        if (closed) return;
        queued.push(data);
        if (queued.length > 4096) return close();
        flush();
      },
      close() {
        release();
        closed = true;
        socket?.end();
      },
    };
  }

  return {
    status: () => ({
      vnc: vncAvailable(),
      proxy: proxyUp,
      hidpi: Boolean(options.scaleCommand),
    }),
    /** Settles once queued scale changes have run (tests). */
    scaleSettled: () => scaling,
    tabs,
    windows,
    activate,
    openVnc,
    start() {
      if (events) return;
      events = new AbortController();
      void subscribe(events.signal);
    },
    stop() {
      events?.abort();
      events = null;
    },
  };
}

export type AgentBrowser = ReturnType<typeof createAgentBrowser>;
