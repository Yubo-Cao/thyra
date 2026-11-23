import {
  parseRemoteMicServerMessage,
  REMOTE_MIC_STATUS_PATH,
  type RemoteMicStatus,
} from "../../../shared/remoteMic";
import { t } from "../i18n";
import {
  type RemoteMicCallbacks,
  type RemoteMicSession,
  remoteMicCloseMessage,
  remoteMicUrl,
} from "./remoteMicProtocol";
import workletUrl from "./remoteMicCapture.worklet.ts?worker&url";

const READY_TIMEOUT_MS = 8_000;

export async function remoteMicStatus(): Promise<RemoteMicStatus> {
  const response = await fetch(REMOTE_MIC_STATUS_PATH, {
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) return { available: false, connections: [] };
  return (await response.json()) as RemoteMicStatus;
}

function microphoneError(error: unknown): Error {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError")
    return new Error(
      t(
        "Microphone access was denied. Allow it for this site in the browser, then try again.",
      ),
    );
  if (name === "NotFoundError")
    return new Error(t("This computer has no microphone."));
  return error instanceof Error ? error : new Error(String(error));
}

/** Open the stream and wait until the host made its source the default. */
function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    const timer = window.setTimeout(() => {
      socket.close();
      reject(new Error(t("The host microphone did not start in time.")));
    }, READY_TIMEOUT_MS);
    let failure = "";
    socket.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      const message = parseRemoteMicServerMessage(event.data);
      if (message?.type === "error") failure = message.message;
      if (message?.type !== "ready") return;
      window.clearTimeout(timer);
      socket.onmessage = null;
      socket.onclose = null;
      resolve(socket);
    };
    socket.onclose = (event) => {
      window.clearTimeout(timer);
      reject(
        new Error(
          failure ||
            event.reason ||
            t(
              "The host microphone is not available for this pane. It works for panes on the Thyra host when you may type into them.",
            ),
        ),
      );
    };
  });
}

/**
 * Stream this computer's microphone to the Thyra host's virtual source.
 * `context` is created during the key press so it may start audio. Resolves
 * once the host plays the stream as its default microphone.
 */
export async function startRemoteMic(
  options: {
    connectionId: string;
    terminalId: string;
    context: AudioContext;
  } & RemoteMicCallbacks,
): Promise<RemoteMicSession> {
  const { context } = options;
  let media: Promise<MediaStream> | null = null;
  let opened: Promise<WebSocket> | null = null;
  try {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia)
      throw new Error(
        t(
          "The host microphone needs a secure origin (HTTPS or localhost) with microphone access.",
        ),
      );
    const status = await remoteMicStatus();
    if (!status.available)
      throw new Error(
        status.reason ??
          t("This Thyra server cannot offer its host microphone."),
      );
    if (!status.connections.includes(options.connectionId))
      throw new Error(
        t(
          "This pane runs on another computer; the host microphone reaches only panes on the Thyra host.",
        ),
      );
    media = navigator.mediaDevices
      .getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })
      .catch((error: unknown) => {
        throw microphoneError(error);
      });
    // Ask for the mic while the host prepares its source.
    opened = connect(
      remoteMicUrl(location, options.connectionId, options.terminalId),
    );
    const [stream, socket] = await Promise.all([media, opened]);
    await context.audioWorklet.addModule(workletUrl);
    if (context.state !== "running") await context.resume();
    return capture(options, stream, socket);
  } catch (error) {
    // Whichever half succeeded (or still will) is released.
    void media?.then(
      (stream) => {
        for (const track of stream.getTracks()) track.stop();
      },
      () => undefined,
    );
    void opened?.then(
      (socket) => socket.close(),
      () => undefined,
    );
    void context.close().catch(() => undefined);
    throw error;
  }
}

function capture(
  callbacks: RemoteMicCallbacks & { context: AudioContext },
  stream: MediaStream,
  socket: WebSocket,
): RemoteMicSession {
  const { context } = callbacks;
  const source = context.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(context, "thyra-remote-mic-capture", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCount: 1,
  });
  const mute = context.createGain();
  mute.gain.value = 0;
  source.connect(node);
  // The worklet outputs silence; routing it keeps the graph pulling audio.
  node.connect(mute).connect(context.destination);

  let released = false;
  let flushed: (() => void) | null = null;
  const resume = () => {
    if (!released && context.state !== "running" && !document.hidden)
      void context.resume().catch(() => undefined);
  };
  context.addEventListener("statechange", resume);
  document.addEventListener("visibilitychange", resume);

  const release = () => {
    if (released) return;
    released = true;
    context.removeEventListener("statechange", resume);
    document.removeEventListener("visibilitychange", resume);
    node.port.onmessage = null;
    socket.onclose = null;
    source.disconnect();
    node.disconnect();
    for (const track of stream.getTracks()) track.stop();
    void context.close().catch(() => undefined);
    socket.close();
    flushed?.();
  };

  node.port.onmessage = (
    event: MessageEvent<
      | { type: "frame"; pcm: Uint8Array<ArrayBuffer>; rms: number }
      | { type: "flushed" }
    >,
  ) => {
    const message = event.data;
    if (message.type === "flushed") {
      flushed?.();
      return;
    }
    if (socket.readyState === WebSocket.OPEN) socket.send(message.pcm);
    callbacks.onLevel(Math.min(1, message.rms * 4));
  };
  socket.onclose = (event) => {
    if (released) return;
    release();
    callbacks.onEnd(remoteMicCloseMessage(event.code, event.reason));
  };
  // It may have closed while the worklet loaded.
  if (socket.readyState !== WebSocket.OPEN) {
    release();
    throw new Error(t("The connection to the host microphone was lost."));
  }

  return {
    async stop() {
      if (released) return;
      await new Promise<void>((resolve) => {
        flushed = resolve;
        node.port.postMessage({ type: "flush" });
        window.setTimeout(resolve, 200);
      });
      flushed = null;
      release();
    },
    cancel: release,
  };
}
