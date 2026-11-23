/** Cuts a sample stream into fixed-size frames for the host-microphone socket. */
export class RemoteMicFramer {
  private pending: Float32Array;
  private filled = 0;

  constructor(private readonly size: number) {
    this.pending = new Float32Array(size);
  }

  /** Whole frames completed by `samples`; the remainder waits. */
  push(samples: Float32Array): Float32Array[] {
    const frames: Float32Array[] = [];
    let offset = 0;
    while (offset < samples.length) {
      const take = Math.min(this.size - this.filled, samples.length - offset);
      this.pending.set(samples.subarray(offset, offset + take), this.filled);
      this.filled += take;
      offset += take;
      if (this.filled === this.size) {
        frames.push(this.pending);
        this.pending = new Float32Array(this.size);
        this.filled = 0;
      }
    }
    return frames;
  }

  /** The partial frame, if any. */
  flush(): Float32Array | null {
    if (this.filled === 0) return null;
    const rest = this.pending.slice(0, this.filled);
    this.filled = 0;
    return rest;
  }
}
