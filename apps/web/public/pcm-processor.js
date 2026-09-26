class Pcm16kProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.pending = new Float32Array(0);
    this.out = new Float32Array(1920 * 4);
    this.outLength = 0;
    this.frame = 1920;
  }

  average(samples, start, end) {
    let sum = 0;
    let cursor = start;
    while (cursor < end) {
      const index = Math.floor(cursor);
      const next = Math.min(end, index + 1);
      sum += samples[index] * (next - cursor);
      cursor = next;
    }
    return sum / (end - start);
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input?.length) return true;
    const merged = new Float32Array(this.pending.length + input.length);
    merged.set(this.pending, 0);
    merged.set(input, this.pending.length);
    const step = sampleRate / 16000;
    let offset = 0;
    while (offset + step <= merged.length) {
      if (this.outLength >= this.out.length) {
        const grown = new Float32Array(this.out.length * 2);
        grown.set(this.out, 0);
        this.out = grown;
      }
      this.out[this.outLength] = this.average(merged, offset, offset + step);
      this.outLength += 1;
      offset += step;
    }
    this.pending = new Float32Array(merged.subarray(Math.floor(offset)));
    while (this.outLength >= this.frame) {
      const pcm = new Int16Array(this.frame);
      for (let i = 0; i < this.frame; i += 1) {
        const sample = Math.max(-1, Math.min(1, this.out[i]));
        pcm[i] = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
      }
      this.out.copyWithin(0, this.frame, this.outLength);
      this.outLength -= this.frame;
      this.port.postMessage(pcm.buffer, [pcm.buffer]);
    }
    return true;
  }
}

registerProcessor('pcm-16k-processor', Pcm16kProcessor);
