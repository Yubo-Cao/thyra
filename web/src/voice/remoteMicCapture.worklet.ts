import {
  floatToS16le,
  REMOTE_MIC_FRAME_SAMPLES,
} from "../../../shared/remoteMic";
import { RemoteMicFramer } from "./remoteMicFramer";
import { VoiceResampler } from "./voiceSegmenter";

const RENDER_QUANTUM = 128;

// AudioWorkletGlobalScope is not part of TypeScript's DOM libraries.
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(
  name: string,
  processor: new () => AudioWorkletProcessor,
): void;

/**
 * Mixes the (noise-suppressed) microphone to mono, low-passes and resamples
 * it to 16 kHz, and posts 20 ms s16le frames for the host-microphone socket,
 * with each frame's RMS level for the indicator.
 */
class RemoteMicCaptureProcessor extends AudioWorkletProcessor {
  private readonly resampler = new VoiceResampler(sampleRate);
  private readonly framer = new RemoteMicFramer(REMOTE_MIC_FRAME_SAMPLES);
  private stopped = false;

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<{ type: string }>) => {
      if (event.data?.type !== "flush") return;
      this.stopped = true;
      const rest = this.framer.flush();
      if (rest) this.post(rest);
      this.port.postMessage({ type: "flushed" });
    };
  }

  private post(frame: Float32Array) {
    let sum = 0;
    for (const sample of frame) sum += sample * sample;
    const pcm = floatToS16le(frame);
    this.port.postMessage(
      { type: "frame", pcm, rms: Math.sqrt(sum / frame.length) },
      [pcm.buffer],
    );
  }

  process(inputs: Float32Array[][]) {
    if (this.stopped) return false;
    const channels = inputs[0] ?? [];
    // A muted or ended source delivers no channels: send silence so the
    // host's recorder keeps receiving audio.
    const frames = channels[0]?.length ?? RENDER_QUANTUM;
    const mono = new Float32Array(frames);
    for (const channel of channels)
      for (let index = 0; index < frames; index++)
        mono[index]! += channel[index]! / channels.length;
    for (const frame of this.framer.push(this.resampler.process(mono)))
      this.post(frame);
    return true;
  }
}

registerProcessor("thyra-remote-mic-capture", RemoteMicCaptureProcessor);
