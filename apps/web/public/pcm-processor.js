class Pcm16kProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.pending = new Float32Array(0);
    this.out = new Float32Array(640 * 4);
    this.outLength = 0;
    /* 40 ms at 16 kHz. Shorter frames leave sooner; the samples are the same. */
    this.frame = 640;
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

  /* Phone mics often arrive as stereo. Mix every channel so one side is not dropped. */
  mono(channels) {
    const first = channels?.[0];
    if (!first?.length) return null;
    const count = channels.length;
    if (count < 2) return first;
    const mixed = new Float32Array(first.length);
    for (let i = 0; i < first.length; i += 1) {
      let sum = 0;
      for (let channel = 0; channel < count; channel += 1) sum += channels[channel]?.[i] ?? 0;
      mixed[i] = sum / count;
    }
    return mixed;
  }

  process(inputs, outputs) {
    /* Copy first. Some browsers reuse the input buffer as the output, so
       silencing the speaker would otherwise erase the microphone samples. */
    const mixed = this.mono(inputs[0]);
    const input = mixed?.length ? new Float32Array(mixed) : null;
    const output = outputs[0]?.[0];
    if (output) output.fill(0);
    if (!input?.length) return true;
    const step = sampleRate > 0 ? sampleRate / 16000 : 3;
    if (!(step > 0)) return true;
    const merged = new Float32Array(this.pending.length + input.length);
    merged.set(this.pending, 0);
    merged.set(input, this.pending.length);
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
    const blockEnd = currentTime + input.length / sampleRate;
    while (this.outLength >= this.frame) {
      const pcm = new Int16Array(this.frame);
      for (let i = 0; i < this.frame; i += 1) {
        const sample = Math.max(-1, Math.min(1, this.out[i]));
        pcm[i] = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
      }
      this.out.copyWithin(0, this.frame, this.outLength);
      this.outLength -= this.frame;
      /* Samples still buffered after this frame were heard later than its last sample. */
      const endTime = blockEnd - (this.outLength * step + this.pending.length) / sampleRate;
      /* Copy instead of transferring. Safari has dropped transferred worklet buffers. */
      this.port.postMessage({ pcm: pcm.buffer.slice(0), endTime });
    }
    return true;
  }
}

registerProcessor('pcm-16k-processor', Pcm16kProcessor);
