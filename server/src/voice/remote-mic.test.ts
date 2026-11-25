import { afterEach, expect, jest, test } from "bun:test";
import { REMOTE_MIC_CLOSE } from "../../../shared/remoteMic";
import {
  createRemoteMic,
  metadataNodeName,
  PcmPacer,
  parseMetadataValue,
  playerCommand,
  REMOTE_MIC_SOURCE,
  type RemoteMicDeps,
  type RemoteMicPlayer,
} from "./remote-mic";

const silent = { info() {}, warn() {}, debug() {} };

afterEach(() => {
  jest.useRealTimers();
});

test("parses pw-metadata output", () => {
  const output = `Found "default" metadata 41
update: id:0 key:'default.configured.audio.source' value:'{ "name": "alsa_input.usb" }' type:'Spa:String:JSON'
`;
  const value = parseMetadataValue(output, "default.configured.audio.source");
  expect(value).toBe('{ "name": "alsa_input.usb" }');
  expect(metadataNodeName(value)).toBe("alsa_input.usb");
  expect(parseMetadataValue(output, "default.audio.source")).toBeNull();
  expect(metadataNodeName("not json")).toBeNull();
});

test("plays stdin as an always-processed Audio/Source node", () => {
  const argv = playerCommand();
  expect(argv.slice(0, 3)).toEqual(["pw-cat", "--playback", "--raw"]);
  expect(argv.at(-1)).toBe("-");
  const props = argv[argv.indexOf("-P") + 1]!;
  expect(props).toContain('media.class = "Audio/Source"');
  expect(props).toContain(`node.name = "${REMOTE_MIC_SOURCE}"`);
  expect(props).toContain("node.always-process = true");
});

test("the pacer keeps a lead of silence and bounds latency", () => {
  const pacer = new PcmPacer(16_000, 100, 500);
  // 100 ms lead at start.
  expect(pacer.start(0).byteLength).toBe(1600 * 2);
  // Nothing due until the clock moves.
  expect(pacer.tick(0)).toBeNull();
  // 20 ms of client audio keeps the queue ahead; no padding needed.
  expect(pacer.push(new Uint8Array(640), 10)).not.toBeNull();
  expect(pacer.tick(20)).toBeNull();
  // The network stalls: silence fills exactly the missing time.
  expect(pacer.tick(60)?.byteLength).toBe((2560 - 1920) * 2);
  // A burst beyond 500 ms ahead is dropped.
  expect(pacer.push(new Uint8Array(16_000 * 2), 60)).toBeNull();
  expect(pacer.push(new Uint8Array(4000 * 2), 60)).not.toBeNull();
});

type Harness = ReturnType<typeof harness>;

function harness(options: { configured?: string | null } = {}) {
  const metadata = new Map<string, string>();
  if (options.configured !== null)
    metadata.set(
      "default.configured.audio.source",
      options.configured ?? '{ "name": "desk_mic" }',
    );
  metadata.set("default.audio.source", '{"name":"desk_mic"}');
  const calls: string[][] = [];
  const players: (RemoteMicPlayer & {
    written: number;
    ended: boolean;
    killed: boolean;
    exit(code: number): void;
  })[] = [];
  const show = (key: string) =>
    metadata.has(key)
      ? `update: id:0 key:'${key}' value:'${metadata.get(key)}' type:'Spa:String:JSON'\n`
      : "";
  const setDefault = () => {
    const configured = metadataNodeName(
      metadata.get("default.configured.audio.source") ?? null,
    );
    const live = players.some((p) => !p.ended && !p.killed);
    metadata.set(
      "default.audio.source",
      JSON.stringify({
        name:
          configured === REMOTE_MIC_SOURCE && !live
            ? "desk_mic"
            : (configured ?? "desk_mic"),
      }),
    );
  };
  const deps: RemoteMicDeps = {
    platform: "linux",
    env: {},
    logger: silent,
    which: (command) => `/usr/bin/${command}`,
    async run(argv) {
      calls.push(argv);
      const key = argv.at(-1)!;
      if (argv.includes("-d")) {
        metadata.delete(key);
        setDefault();
      } else if (argv.length === 7) {
        metadata.set(argv[4]!, argv[5]!);
        setDefault();
      } else return { code: 0, stdout: show(key), stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    runSync(argv) {
      calls.push(["sync", ...argv]);
    },
    spawn(argv) {
      calls.push(argv);
      let exit: (code: number) => void = () => {};
      const player = {
        written: 0,
        ended: false,
        killed: false,
        write(bytes: Uint8Array) {
          player.written += bytes.byteLength;
        },
        end() {
          player.ended = true;
          exit(0);
        },
        kill() {
          player.killed = true;
          exit(143);
        },
        exited: new Promise<number>((resolve) => {
          exit = resolve;
        }),
        exit: (code: number) => exit(code),
      };
      players.push(player);
      return player;
    },
  };
  const mic = createRemoteMic(deps);
  const peer = () => {
    const sent: unknown[] = [];
    const closed: [number, string][] = [];
    return {
      sent,
      closed,
      send: (message: string) => sent.push(JSON.parse(message)),
      close: (code: number, reason: string) => closed.push([code, reason]),
    };
  };
  return { mic, metadata, calls, players, peer, deps };
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

async function started(h: Harness) {
  const page = h.peer();
  const stream = h.mic.open(page);
  await settle();
  return { page, stream };
}

test("makes the node the default while streaming and restores it after", async () => {
  const h = harness();
  const { page, stream } = await started(h);
  expect(page.sent).toEqual([{ type: "ready", source: REMOTE_MIC_SOURCE }]);
  expect(h.metadata.get("default.configured.audio.source")).toBe(
    JSON.stringify({ name: REMOTE_MIC_SOURCE }),
  );
  const player = h.players[0]!;
  const lead = player.written;
  expect(lead).toBeGreaterThan(0);
  stream.audio(new Uint8Array(640));
  expect(player.written).toBe(lead + 640);

  await stream.close();
  expect(h.metadata.get("default.configured.audio.source")).toBe(
    '{ "name": "desk_mic" }',
  );
  expect(player.ended).toBe(true);
  expect(page.closed).toEqual([]);
});

test("deletes a configured default that was not set before", async () => {
  const h = harness({ configured: null });
  const { stream } = await started(h);
  await stream.close();
  expect(h.metadata.has("default.configured.audio.source")).toBe(false);
  expect(h.calls.some((argv) => argv.includes("-d"))).toBe(true);
});

test("keeps a default someone picked during the stream", async () => {
  const h = harness();
  const { stream } = await started(h);
  h.metadata.set("default.configured.audio.source", '{ "name": "headset" }');
  await stream.close();
  expect(h.metadata.get("default.configured.audio.source")).toBe(
    '{ "name": "headset" }',
  );
});

test("the newest page wins; the previous one is told and cleaned up", async () => {
  const h = harness();
  const first = await started(h);
  const second = await started(h);
  expect(first.page.closed).toEqual([
    [REMOTE_MIC_CLOSE.superseded, "another page took the host microphone"],
  ]);
  expect(h.players[0]!.ended).toBe(true);
  expect(second.page.sent).toEqual([
    { type: "ready", source: REMOTE_MIC_SOURCE },
  ]);
  // The second stream restores the default the first one found.
  await second.stream.close();
  expect(h.metadata.get("default.configured.audio.source")).toBe(
    '{ "name": "desk_mic" }',
  );
});

test("drops audio before ready and rejects malformed frames", async () => {
  const h = harness();
  const page = h.peer();
  const stream = h.mic.open(page);
  stream.audio(new Uint8Array(640));
  await settle();
  const player = h.players[0]!;
  const before = player.written;
  stream.audio(new Uint8Array(3));
  expect(player.written).toBe(before);
  expect(page.sent.at(-1)).toEqual({
    type: "error",
    message: "invalid audio frame",
  });
  expect(page.closed[0]?.[0]).toBe(REMOTE_MIC_CLOSE.failed);
  await settle();
  expect(player.ended).toBe(true);
});

test("a page that closes during setup leaves nothing behind", async () => {
  const h = harness();
  const page = h.peer();
  const stream = h.mic.open(page);
  void stream.close();
  await settle();
  await h.mic.stop();
  expect(page.sent).toEqual([]);
  expect(h.metadata.get("default.configured.audio.source")).toBe(
    '{ "name": "desk_mic" }',
  );
  expect(h.players.every((p) => p.ended || p.killed)).toBe(true);
});

test("a player that dies ends the stream", async () => {
  const h = harness();
  const { page } = await started(h);
  h.players[0]!.exit(1);
  await settle();
  expect(page.closed[0]?.[0]).toBe(REMOTE_MIC_CLOSE.failed);
  expect(h.metadata.get("default.configured.audio.source")).toBe(
    '{ "name": "desk_mic" }',
  );
});

test("an idle stream is closed", async () => {
  jest.useFakeTimers();
  let clock = 0;
  const h = harness();
  const mic = createRemoteMic({ ...h.deps, now: () => clock });
  const page = h.peer();
  mic.open(page);
  // Setup awaits promises only; flush them with real microtasks.
  for (let i = 0; i < 50; i++) await Promise.resolve();
  expect(page.sent).toEqual([{ type: "ready", source: REMOTE_MIC_SOURCE }]);
  clock = 16_000;
  jest.advanceTimersByTime(20);
  expect(page.closed[0]?.[0]).toBe(REMOTE_MIC_CLOSE.idle);
});

test("shutdown restores the default", async () => {
  const h = harness();
  const { page } = await started(h);
  await h.mic.stop();
  expect(page.closed[0]?.[0]).toBe(REMOTE_MIC_CLOSE.shutdown);
  expect(h.metadata.get("default.configured.audio.source")).toBe(
    '{ "name": "desk_mic" }',
  );
});

test("exit restores synchronously", async () => {
  const h = harness();
  await started(h);
  h.mic.stopSync();
  expect(h.calls.at(-1)).toEqual([
    "sync",
    "pw-metadata",
    "-n",
    "default",
    "0",
    "default.configured.audio.source",
    '{ "name": "desk_mic" }',
    "Spa:String:JSON",
  ]);
  expect(h.players[0]!.killed).toBe(true);
});

test("reports why the host cannot offer it", async () => {
  const base = harness().deps;
  expect(
    await createRemoteMic({ ...base, platform: "darwin" }).status(),
  ).toMatchObject({ available: false });
  expect(
    await createRemoteMic({ ...base, which: () => null }).status(),
  ).toEqual({
    available: false,
    reason: "The host has no pw-cat or pw-metadata (PipeWire tools).",
  });
  expect(
    await createRemoteMic({
      ...base,
      env: { THYRA_REMOTE_MIC: "off" },
    }).status(),
  ).toMatchObject({ available: false });
  expect(
    await createRemoteMic({
      ...base,
      run: async () => ({ code: 1, stdout: "", stderr: "no pipewire" }),
    }).status(),
  ).toMatchObject({ available: false });
  expect(await createRemoteMic(base).status()).toEqual({
    available: true,
    dictation: false,
  });
  const page = harness().peer();
  createRemoteMic({ ...base, platform: "darwin" }).open(page);
  await settle();
  expect(page.closed[0]?.[0]).toBe(REMOTE_MIC_CLOSE.failed);
});

function fakeTranscriber(text = "hello there") {
  const log: string[] = [];
  return {
    log,
    available: () => ({ available: true }),
    stop: () => log.push("stop"),
    async begin() {
      log.push("begin");
      return {
        async finish() {
          log.push("finish");
          return text;
        },
        async cancel() {
          log.push("cancel");
        },
      };
    },
  };
}

test("a dictation is ready once the transcriber records, and answers stop with the transcript", async () => {
  const transcriber = fakeTranscriber();
  const h = harness();
  const mic = createRemoteMic({ ...h.deps, transcriber });
  expect(await mic.status()).toMatchObject({ dictation: true });
  const page = h.peer();
  const stream = mic.open(page, { dictate: true });
  await settle();
  expect(transcriber.log).toEqual(["begin"]);
  expect(page.sent).toEqual([{ type: "ready", source: REMOTE_MIC_SOURCE }]);
  stream.control('{"type":"stop"}');
  // Audio still reaches the host while the transcript is taken.
  const player = h.players[0]!;
  const before = player.written;
  stream.audio(new Uint8Array(640));
  expect(player.written).toBe(before + 640);
  await settle();
  expect(transcriber.log).toEqual(["begin", "finish"]);
  expect(page.sent.at(-1)).toEqual({ type: "transcript", text: "hello there" });
  expect(page.closed).toEqual([[1000, "done"]]);
  await settle();
  expect(h.metadata.get("default.configured.audio.source")).toBe(
    '{ "name": "desk_mic" }',
  );
});

test("closing a dictation early throws the take away", async () => {
  const transcriber = fakeTranscriber();
  const h = harness();
  const mic = createRemoteMic({ ...h.deps, transcriber });
  const stream = mic.open(h.peer(), { dictate: true });
  await settle();
  await stream.close();
  expect(transcriber.log).toEqual(["begin", "cancel"]);
});

test("a plain stream ignores stop and never starts the transcriber", async () => {
  const transcriber = fakeTranscriber();
  const h = harness();
  const mic = createRemoteMic({ ...h.deps, transcriber });
  const page = h.peer();
  const stream = mic.open(page);
  await settle();
  stream.control('{"type":"stop"}');
  await settle();
  expect(transcriber.log).toEqual([]);
  expect(page.closed).toEqual([]);
  await stream.close();
});
