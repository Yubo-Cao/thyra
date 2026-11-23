import {
  isRemoteMicFrame,
  REMOTE_MIC_CLOSE,
  REMOTE_MIC_SAMPLE_RATE,
  type RemoteMicServerMessage,
} from "../../../shared/remoteMic";
import { thyraEnv } from "../config/environment";
import type { Logger } from "../utils/logger";

/**
 * The host microphone a remote browser speaks into (see shared/remoteMic.ts).
 *
 * While a page streams, `pw-cat` plays its PCM as a PipeWire node of class
 * `Audio/Source` named `thyra_remote_mic`, and that node is made the
 * configured default source, so any recorder that opens the default mic
 * (Claude Code's `arecord` or native capture) hears the remote speaker. The
 * node exists only while `pw-cat` runs: when the stream ends, the previous
 * configured default is written back and `pw-cat` exits, so the desk mic
 * is the default again. A crashed bridge leaves no node behind (`pw-cat`
 * exits on end of input), only the configured name, which WirePlumber skips
 * while the node is absent.
 *
 * One page streams at a time: the newest wins, and the previous page is told
 * (`REMOTE_MIC_CLOSE.superseded`). That suits moving between computers,
 * where the old page may still be open.
 */

export const REMOTE_MIC_SOURCE = "thyra_remote_mic";
const CONFIGURED_KEY = "default.configured.audio.source";
const DEFAULT_KEY = "default.audio.source";
/** Silence kept queued ahead of the clock so the node never runs dry. */
const LEAD_MS = 120;
/** Audio further ahead than this is dropped rather than delayed. */
const MAX_AHEAD_MS = 1_000;
const PACE_INTERVAL_MS = 20;
/** How long WirePlumber may take to switch the default to the new node. */
const DEFAULT_SWITCH_TIMEOUT_MS = 3_000;
const DEFAULT_POLL_MS = 50;
/** A streaming page that sends nothing for this long is closed. */
const IDLE_TIMEOUT_MS = 15_000;
const STATUS_TTL_MS = 30_000;

export type RemoteMicRun = (
  argv: string[],
) => Promise<{ code: number; stdout: string; stderr: string }>;

export type RemoteMicPlayer = {
  write(bytes: Uint8Array): void;
  /** Close its input; `pw-cat` plays what is queued and exits. */
  end(): void;
  kill(): void;
  exited: Promise<number>;
};

export type RemoteMicPeer = {
  send(message: string): void;
  close(code: number, reason: string): void;
};

export type RemoteMicDeps = {
  run: RemoteMicRun;
  spawn: (argv: string[]) => RemoteMicPlayer;
  /** Synchronous runner for process exit, where nothing can be awaited. */
  runSync: (argv: string[]) => void;
  which: (command: string) => string | null;
  platform: string;
  env: Record<string, string | undefined>;
  logger: Pick<Logger, "info" | "warn" | "debug">;
  now?: () => number;
};

/**
 * Feeds the player in real time: client audio is written as it arrives, and
 * silence tops the queue up to `LEAD_MS` ahead of the clock whenever the
 * network falls behind. Audio that would put the queue more than
 * `MAX_AHEAD_MS` ahead (a burst after a stall) is dropped to bound latency.
 */
export class PcmPacer {
  private startedAt = 0;
  private written = 0;

  constructor(
    private readonly rate = REMOTE_MIC_SAMPLE_RATE,
    private readonly leadMs = LEAD_MS,
    private readonly maxAheadMs = MAX_AHEAD_MS,
  ) {}

  private due(now: number) {
    return Math.floor(
      ((now - this.startedAt + this.leadMs) * this.rate) / 1000,
    );
  }

  /** The initial lead of silence. */
  start(now: number): Uint8Array {
    this.startedAt = now;
    this.written = 0;
    return this.tick(now) ?? new Uint8Array(0);
  }

  /** Client PCM to write now, or null when it would add too much delay. */
  push(bytes: Uint8Array, now: number): Uint8Array | null {
    const samples = bytes.byteLength >> 1;
    const limit = this.due(now) + (this.maxAheadMs * this.rate) / 1000;
    if (this.written + samples > limit) return null;
    this.written += samples;
    return bytes;
  }

  /** Silence that keeps the lead, or null when the queue is full enough. */
  tick(now: number): Uint8Array | null {
    const missing = this.due(now) - this.written;
    if (missing <= 0) return null;
    this.written += missing;
    return new Uint8Array(missing * 2);
  }
}

/** The `pw-cat` command that plays stdin as the virtual source node. */
export function playerCommand(source = REMOTE_MIC_SOURCE): string[] {
  return [
    "pw-cat",
    "--playback",
    "--raw",
    "--latency",
    "40ms",
    "--rate",
    String(REMOTE_MIC_SAMPLE_RATE),
    "--channels",
    "1",
    "--channel-map",
    "mono",
    "--format",
    "s16",
    "-P",
    // always-process: consume input in real time even before a recorder
    // links, so queued audio never goes stale.
    `{ media.class = "Audio/Source", node.name = "${source}", node.description = "Thyra remote microphone", node.autoconnect = false, node.always-process = true }`,
    "-",
  ];
}

/** The JSON value `pw-metadata` printed for `key`, or null when unset. */
export function parseMetadataValue(output: string, key: string): string | null {
  for (const line of output.split("\n")) {
    const match = /key:'([^']*)' value:'(.*)' type:'[^']*'\s*$/.exec(line);
    if (match && match[1] === key) return match[2]!;
  }
  return null;
}

/** The node name in a default-node metadata value (`{ "name": "..." }`). */
export function metadataNodeName(value: string | null): string | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as { name?: unknown };
    return typeof parsed.name === "string" ? parsed.name : null;
  } catch {
    return null;
  }
}

const readMetadataArgv = (key: string) => [
  "pw-metadata",
  "-n",
  "default",
  "0",
  key,
];
const writeMetadataArgv = (key: string, value: string) => [
  "pw-metadata",
  "-n",
  "default",
  "0",
  key,
  value,
  "Spa:String:JSON",
];
const deleteMetadataArgv = (key: string) => [
  "pw-metadata",
  "-n",
  "default",
  "-d",
  "0",
  key,
];
const sourceValue = (name: string) => JSON.stringify({ name });

export type RemoteMicAvailability = { available: boolean; reason?: string };

type Session = {
  peer: RemoteMicPeer;
  state: "starting" | "streaming" | "closed";
  player: RemoteMicPlayer | null;
  pacer: PcmPacer;
  timer: ReturnType<typeof setInterval> | null;
  lastAudioAt: number;
  /** The configured default before this stream; undefined until read. */
  previous: string | null | undefined;
  /** Whether this stream wrote the configured default. */
  switched: boolean;
  teardown: Promise<void> | null;
};

export function createRemoteMic(deps: RemoteMicDeps) {
  const now = deps.now ?? Date.now;
  const { logger } = deps;
  let cachedStatus: { at: number; value: RemoteMicAvailability } | null = null;
  let active: Session | null = null;
  // Setup and teardown of successive streams run in order, so a new stream
  // reads the default its predecessor restored.
  let chain: Promise<void> = Promise.resolve();
  const serial = (task: () => Promise<void>) => {
    const next = chain.then(task, task);
    chain = next.catch(() => undefined);
    return next;
  };

  async function readMetadata(key: string): Promise<string | null> {
    const { code, stdout, stderr } = await deps.run(readMetadataArgv(key));
    if (code !== 0)
      throw new Error(`pw-metadata failed: ${stderr.trim() || code}`);
    return parseMetadataValue(stdout, key);
  }

  async function runChecked(argv: string[]) {
    const { code, stderr } = await deps.run(argv);
    if (code !== 0)
      throw new Error(`${argv[0]} failed: ${stderr.trim() || code}`);
  }

  async function availability(): Promise<RemoteMicAvailability> {
    const setting = thyraEnv("REMOTE_MIC", deps.env)?.trim().toLowerCase();
    if (setting && ["0", "off", "false", "no"].includes(setting))
      return {
        available: false,
        reason: "The host microphone is turned off (THYRA_REMOTE_MIC).",
      };
    if (deps.platform !== "linux")
      return {
        available: false,
        reason: "The host microphone needs a Linux host with PipeWire.",
      };
    const missing = ["pw-cat", "pw-metadata"].filter((c) => !deps.which(c));
    if (missing.length)
      return {
        available: false,
        reason: `The host has no ${missing.join(" or ")} (PipeWire tools).`,
      };
    if (cachedStatus && now() - cachedStatus.at < STATUS_TTL_MS)
      return cachedStatus.value;
    let value: RemoteMicAvailability;
    try {
      await readMetadata(DEFAULT_KEY);
      value = { available: true };
    } catch (error) {
      value = {
        available: false,
        reason: `PipeWire is not reachable on the host: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    cachedStatus = { at: now(), value };
    return value;
  }

  function send(session: Session, message: RemoteMicServerMessage) {
    if (session.state === "closed") return;
    try {
      session.peer.send(JSON.stringify(message));
    } catch {}
  }

  function write(session: Session, bytes: Uint8Array | null) {
    if (!bytes || bytes.byteLength === 0 || !session.player) return;
    try {
      session.player.write(bytes);
    } catch (error) {
      fail(session, error);
    }
  }

  function fail(session: Session, error: unknown) {
    if (session.state === "closed") return;
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("host microphone failed", { error: message });
    send(session, { type: "error", message });
    end(session, REMOTE_MIC_CLOSE.failed, "host microphone failed");
  }

  /** Close the page's socket and restore the host; idempotent. */
  function end(session: Session, code: number, reason: string) {
    if (session.state !== "closed") {
      session.state = "closed";
      try {
        session.peer.close(code, reason);
      } catch {}
    }
    return teardown(session);
  }

  function teardown(session: Session): Promise<void> {
    session.state = "closed";
    if (active === session) active = null;
    if (session.timer) clearInterval(session.timer);
    session.timer = null;
    session.teardown ??= serial(async () => {
      // Setup may have started the clock after the socket closed.
      if (session.timer) clearInterval(session.timer);
      session.timer = null;
      try {
        await restoreDefault(session);
      } catch (error) {
        logger.warn("host microphone could not restore the default source", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      const player = session.player;
      session.player = null;
      if (player) await stopPlayer(player);
      logger.info("host microphone stopped");
    });
    return session.teardown;
  }

  async function restoreDefault(session: Session) {
    if (!session.switched) return;
    session.switched = false;
    // Leave a default someone chose while the stream ran.
    const current = metadataNodeName(await readMetadata(CONFIGURED_KEY));
    if (current !== REMOTE_MIC_SOURCE) return;
    await runChecked(
      session.previous
        ? writeMetadataArgv(CONFIGURED_KEY, session.previous)
        : deleteMetadataArgv(CONFIGURED_KEY),
    );
  }

  async function stopPlayer(player: RemoteMicPlayer) {
    try {
      player.end();
    } catch {}
    let timer: ReturnType<typeof setTimeout> | null = null;
    const exited = await Promise.race([
      player.exited.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 1_000);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (!exited) {
      try {
        player.kill();
      } catch {}
    }
  }

  async function setup(session: Session) {
    // The page may close at any await below.
    const closed = () => session.state === "closed";
    const status = await availability();
    if (!status.available) throw new Error(status.reason);
    if (closed()) return;
    const previous = await readMetadata(CONFIGURED_KEY);
    if (closed()) return;
    // A name left by a crashed bridge is not worth restoring.
    session.previous =
      metadataNodeName(previous) === REMOTE_MIC_SOURCE ? null : previous;
    const player = deps.spawn(playerCommand());
    session.player = player;
    void player.exited.then((code) => {
      if (session.player === player && session.state !== "closed")
        fail(session, new Error(`pw-cat exited (${code})`));
    });
    write(session, session.pacer.start(now()));
    session.timer = setInterval(() => {
      if (session.state === "closed") return;
      if (
        session.state === "streaming" &&
        now() - session.lastAudioAt > IDLE_TIMEOUT_MS
      ) {
        void end(session, REMOTE_MIC_CLOSE.idle, "no audio");
        return;
      }
      write(session, session.pacer.tick(now()));
    }, PACE_INTERVAL_MS);
    session.switched = true;
    await runChecked(
      writeMetadataArgv(CONFIGURED_KEY, sourceValue(REMOTE_MIC_SOURCE)),
    );
    // Recorders open the effective default, which WirePlumber moves to the
    // node once it appears.
    const deadline = now() + DEFAULT_SWITCH_TIMEOUT_MS;
    while (
      metadataNodeName(await readMetadata(DEFAULT_KEY)) !== REMOTE_MIC_SOURCE
    ) {
      if (closed()) return;
      if (now() > deadline)
        throw new Error(
          "PipeWire did not make the host microphone the default source",
        );
      await new Promise((resolve) => setTimeout(resolve, DEFAULT_POLL_MS));
    }
  }

  return {
    status: availability,

    /** Start a stream for a page; the previous page's stream ends. */
    open(peer: RemoteMicPeer) {
      const previous = active;
      const session: Session = {
        peer,
        state: "starting",
        player: null,
        pacer: new PcmPacer(),
        timer: null,
        lastAudioAt: now(),
        previous: undefined,
        switched: false,
        teardown: null,
      };
      active = session;
      if (previous)
        void end(
          previous,
          REMOTE_MIC_CLOSE.superseded,
          "another page took the host microphone",
        );
      void serial(() => setup(session)).then(
        () => {
          if (session.state !== "starting") return;
          session.state = "streaming";
          session.lastAudioAt = now();
          logger.info("host microphone started", { source: REMOTE_MIC_SOURCE });
          send(session, { type: "ready", source: REMOTE_MIC_SOURCE });
        },
        (error) => fail(session, error),
      );
      return {
        /** A binary frame from the page. */
        audio(bytes: Uint8Array) {
          if (session.state !== "streaming") return;
          if (!isRemoteMicFrame(bytes.byteLength)) {
            fail(session, new Error("invalid audio frame"));
            return;
          }
          session.lastAudioAt = now();
          write(session, session.pacer.push(bytes, now()));
        },
        /** The page's socket closed. */
        close: () => teardown(session),
      };
    },

    /** End the stream on shutdown, restoring the default source. */
    stop(): Promise<void> {
      return active
        ? end(active, REMOTE_MIC_CLOSE.shutdown, "Thyra is stopping")
        : chain;
    },

    /** Best-effort restore at process exit, where nothing can be awaited. */
    stopSync() {
      const session = active;
      if (!session) return;
      session.state = "closed";
      active = null;
      if (session.timer) clearInterval(session.timer);
      if (session.switched) {
        session.switched = false;
        try {
          deps.runSync(
            session.previous
              ? writeMetadataArgv(CONFIGURED_KEY, session.previous)
              : deleteMetadataArgv(CONFIGURED_KEY),
          );
        } catch {}
      }
      try {
        session.player?.kill();
      } catch {}
    },
  };
}

export type RemoteMic = ReturnType<typeof createRemoteMic>;

/** The service with real processes. */
export function createHostRemoteMic(logger: RemoteMicDeps["logger"]) {
  return createRemoteMic({
    logger,
    platform: process.platform,
    env: process.env,
    which: (command) => Bun.which(command),
    run: async (argv) => {
      const proc = Bun.spawn(argv, {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      return { code, stdout, stderr };
    },
    runSync: (argv) => {
      Bun.spawnSync(argv, {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
    },
    spawn: (argv) => {
      const proc = Bun.spawn(argv, {
        stdin: "pipe",
        stdout: "ignore",
        stderr: "pipe",
      });
      const stderr = new Response(proc.stderr).text();
      return {
        write(bytes) {
          proc.stdin.write(bytes);
          void proc.stdin.flush();
        },
        end() {
          void proc.stdin.end();
        },
        kill() {
          proc.kill();
        },
        exited: proc.exited.then(async (code) => {
          if (code !== 0)
            logger.debug("pw-cat exited", {
              code,
              stderr: (await stderr).trim().slice(0, 300),
            });
          return code;
        }),
      };
    },
  });
}
