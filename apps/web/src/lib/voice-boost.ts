/** 16 kHz mono PCM from the capture worklet. Quiet classroom speech is often
 *  well below the level a recognizer was tuned on, while a flat gain would
 *  also turn the room into noise the recognizer treats as speech. */
const RATE = 16_000;
const TARGET_RMS = 0.08;
const MAX_GAIN = 12;
/** About +8 dB above the tracked room level. */
const SPEECH_RATIO = 2.5;
const MIN_SPEECH_RMS = 0.003;
const HOLD_FRAMES = 8;
const RISE = 0.22;
const FALL = 0.55;
const FLOOR_CLAMP = 0.0015;
/** The smoothed gain needs several frames to come down, so a clap after quiet speech is capped at once. */
const PEAK_CEILING = 0.7;
/** ~1 s of past levels. Speech keeps moving; a fan or hum does not. */
const RECENT_LEVELS = 24;
const STEADY_VARIATION = 0.08;

const highpass = highpassCoeffs(70);

type Coeffs = { b0: number; b1: number; b2: number; a1: number; a2: number };
type Stage = { x1: number; x2: number; y1: number; y2: number };

function highpassCoeffs(fc: number): Coeffs {
  const w0 = (2 * Math.PI * fc) / RATE;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
  const a0 = 1 + alpha;
  return {
    b0: ((1 + cos) / 2) / a0,
    b1: -(1 + cos) / a0,
    b2: ((1 + cos) / 2) / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0
  };
}

function stage(): Stage {
  return { x1: 0, x2: 0, y1: 0, y2: 0 };
}

function filterSample(sample: number, coeffs: Coeffs, memory: Stage) {
  const y = coeffs.b0 * sample + coeffs.b1 * memory.x1 + coeffs.b2 * memory.x2 - coeffs.a1 * memory.y1 - coeffs.a2 * memory.y2;
  memory.x2 = memory.x1;
  memory.x1 = sample;
  memory.y2 = memory.y1;
  memory.y1 = Number.isFinite(y) ? y : 0;
  if (!Number.isFinite(y)) memory.x1 = memory.x2 = memory.y2 = 0;
  return memory.y1;
}

function toFloat(sample: number) {
  return sample < 0 ? sample / 0x8000 : sample / 0x7fff;
}

function toPcm(sample: number) {
  if (!Number.isFinite(sample)) return 0;
  const clamped = sample < -1 ? -1 : sample > 1 ? 1 : sample;
  return clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
}

/** Keeps peaks from turning into hard clipping after a quiet passage is lifted. */
function softLimit(sample: number) {
  const knee = 0.82;
  const abs = Math.abs(sample);
  if (abs <= knee) return sample;
  const sign = sample < 0 ? -1 : 1;
  return sign * (knee + (1 - knee) * Math.tanh((abs - knee) / (1 - knee)));
}

export class VoiceBoost {
  private readonly low = stage();
  private readonly low2 = stage();
  private filtered = new Float32Array(0);
  private recent: number[] = [];
  private noise = FLOOR_CLAMP;
  private primed = false;
  private gain = 1;
  private speechGain = 1;
  private hold = 0;
  private mix = 0;

  /** A new capture must not inherit the previous room or a gain left over from it. */
  reset() {
    this.low.x1 = this.low.x2 = this.low.y1 = this.low.y2 = 0;
    this.low2.x1 = this.low2.x2 = this.low2.y1 = this.low2.y2 = 0;
    this.recent = [];
    this.noise = FLOOR_CLAMP;
    this.primed = false;
    this.gain = 1;
    this.speechGain = 1;
    this.hold = 0;
    this.mix = 0;
  }

  /** `enabled` can change between frames. Off still tracks the room, so turning it on is immediate. */
  process(pcm: ArrayBuffer, enabled: boolean) {
    if (pcm.byteLength < 2 || pcm.byteLength % 2 !== 0) return pcm;
    const input = new Int16Array(pcm);
    if (this.filtered.length !== input.length) this.filtered = new Float32Array(input.length);
    let energy = 0;
    let peak = 0;
    for (let i = 0; i < input.length; i += 1) {
      const sample = filterSample(filterSample(toFloat(input[i]), highpass, this.low), highpass, this.low2);
      this.filtered[i] = sample;
      energy += sample * sample;
      const abs = Math.abs(sample);
      if (abs > peak) peak = abs;
    }
    const rms = Math.sqrt(energy / input.length);
    /* The floor stays put while the level keeps changing, so a sentence longer
       than a second does not become its own noise. A flat hum is allowed to
       catch up, otherwise a fan that starts mid-session would be lifted forever. */
    const steady = this.levelVariation() < STEADY_VARIATION;
    const speech = this.primed && rms >= this.noise * SPEECH_RATIO && rms >= MIN_SPEECH_RMS;
    let desired = 1;
    if (speech) {
      this.hold = HOLD_FRAMES;
      desired = Math.min(MAX_GAIN, Math.max(1, TARGET_RMS / Math.max(rms, 1e-6)));
      this.speechGain = desired;
    } else if (this.hold > 0) {
      this.hold -= 1;
      desired = this.speechGain;
    }
    const ceiling = peak > 0 ? Math.max(1, PEAK_CEILING / peak) : MAX_GAIN;
    if (this.gain > ceiling) this.gain = ceiling;
    const nextGain = Math.min(ceiling, this.gain + (desired - this.gain) * (desired < this.gain ? FALL : RISE));
    this.track(rms, speech, steady);
    const mixFrom = this.mix;
    const mixTo = this.mix + ((enabled ? 1 : 0) - this.mix) * 0.5;
    this.mix = mixTo;
    if (mixFrom <= 0.001 && mixTo <= 0.001) {
      this.gain = nextGain;
      return pcm;
    }
    const output = new Int16Array(input.length);
    const last = Math.max(1, input.length - 1);
    for (let i = 0; i < input.length; i += 1) {
      const t = i / last;
      const gain = this.gain + (nextGain - this.gain) * t;
      const mix = mixFrom + (mixTo - mixFrom) * t;
      const wet = softLimit(this.filtered[i] * gain);
      const dry = toFloat(input[i]);
      output[i] = toPcm(dry + (wet - dry) * mix);
    }
    this.gain = nextGain;
    return output.buffer;
  }

  private levelVariation() {
    const count = this.recent.length;
    if (count < 12) return 1;
    let mean = 0;
    for (let i = 0; i < count; i += 1) mean += this.recent[i];
    mean /= count;
    if (mean < 1e-6) return 0;
    let acc = 0;
    for (let i = 0; i < count; i += 1) {
      const delta = this.recent[i] - mean;
      acc += delta * delta;
    }
    return Math.sqrt(acc / count) / mean;
  }

  private track(rms: number, speech: boolean, steady: boolean) {
    if (!this.primed) {
      this.noise = Math.max(rms, FLOOR_CLAMP);
      this.primed = true;
    } else if (rms < this.noise) {
      this.noise += (rms - this.noise) * 0.35;
    } else if (steady) {
      this.noise += (rms - this.noise) * 0.22;
    } else if (!speech) {
      this.noise += (rms - this.noise) * 0.03;
    }
    if (this.noise < FLOOR_CLAMP) this.noise = FLOOR_CLAMP;
    else if (this.noise > 0.3) this.noise = 0.3;
    this.recent.push(rms);
    if (this.recent.length > RECENT_LEVELS) this.recent.shift();
  }
}
