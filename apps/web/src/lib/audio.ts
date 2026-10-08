export type AudioSource = 'microphone' | 'system';

const TARGET_RATE = 16000;
/** 40 ms at 16 kHz. The samples are unchanged; a 120 ms frame only held them back. */
const FRAME = 640;
/** Keep the same backlog the old 120 ms frames allowed, so a shorter frame does not discard more speech. */
export const QUEUED_AUDIO_LIMIT_MS = 24_000;

export function trimQueuedAudio<T extends { durationMs: number }>(queue: T[], limitMs = QUEUED_AUDIO_LIMIT_MS) {
  let total = 0;
  for (const item of queue) total += item.durationMs;
  while (queue.length > 1 && total > limitMs) total -= queue.shift()?.durationMs ?? 0;
}

function openAudioContext(Ctor: typeof AudioContext) {
  try {
    return new Ctor({ latencyHint: 'interactive' });
  } catch {
    return new Ctor();
  }
}

export async function listAudioInputs() {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((device) => device.kind === 'audioinput' && device.deviceId).map((device, index) => ({ id: device.deviceId, label: device.label || `Microphone ${index + 1}` }));
}

function constraintFailure(error: unknown) {
  const name = error instanceof DOMException ? error.name : '';
  return name === 'OverconstrainedError' || name === 'ConstraintError' || name === 'NotFoundError';
}

/* A bare `channelCount: 1` or `echoCancellation: true` is a required constraint.
   iOS and many Android mics reject that with OverconstrainedError, so the
   session never starts. Ask for a plain mic inside the tap, then tighten. */
async function openMicrophone(deviceId?: string) {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: deviceId ? { deviceId: { ideal: deviceId } } : true });
  } catch (error) {
    if (!deviceId || !constraintFailure(error)) throw error;
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  }
  const track = stream.getAudioTracks()[0];
  await track?.applyConstraints({ channelCount: { ideal: 1 }, echoCancellation: { ideal: true }, noiseSuppression: { ideal: true }, autoGainControl: { ideal: true } }).catch(() => undefined);
  return stream;
}

/* A silent buffer started in the same turn as the tap is what marks the
   context as allowed on iOS. resume() alone is not enough once a permission
   sheet has stolen the gesture. */
function unlockContext(context: AudioContext) {
  const resumed = context.resume();
  const buffer = context.createBuffer(1, 1, context.sampleRate || TARGET_RATE);
  const player = context.createBufferSource();
  player.buffer = buffer;
  player.connect(context.destination);
  try { player.start(); } catch { /* Already running, or the context was closed. */ }
  return resumed;
}

function waitUntilRunning(context: AudioContext) {
  if (context.state === 'running') return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error('麦克风已打开，但浏览器还没有允许播放音频。请再点一次「开始翻译」。'));
    }, 12_000);
    const finish = () => { if (context.state === 'running') { cleanup(); resolve(); } };
    const onGesture = () => { void context.resume().then(finish).catch(() => undefined); };
    const onVisible = () => { if (document.visibilityState === 'visible') onGesture(); };
    function cleanup() {
      window.clearTimeout(timer);
      context.removeEventListener('statechange', finish);
      window.removeEventListener('pointerdown', onGesture);
      document.removeEventListener('visibilitychange', onVisible);
    }
    context.addEventListener('statechange', finish);
    window.addEventListener('pointerdown', onGesture);
    document.addEventListener('visibilitychange', onVisible);
    onGesture();
  });
}

function average(samples: Float32Array, start: number, end: number) {
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

export type PcmChunkHandler = (chunk: ArrayBuffer, capturedAt?: number) => void;

/** Maps an audio-context time to performance.now(). Falls back to arrival time when the browser gives no timestamp. */
function captureClock(context: AudioContext, media: MediaStream) {
  const settings = media.getAudioTracks()[0]?.getSettings() as (MediaTrackSettings & { latency?: number }) | undefined;
  const inputLatencyMs = typeof settings?.latency === 'number' && settings.latency > 0 ? Math.min(settings.latency, 0.5) * 1000 : 0;
  return (contextSeconds?: number) => {
    const now = performance.now();
    const stamp = typeof contextSeconds === 'number' && Number.isFinite(contextSeconds) && typeof context.getOutputTimestamp === 'function' ? context.getOutputTimestamp() : null;
    if (!stamp?.performanceTime || typeof stamp.contextTime !== 'number' || typeof contextSeconds !== 'number') return now - inputLatencyMs;
    const at = stamp.performanceTime - (stamp.contextTime - contextSeconds) * 1000 - inputLatencyMs;
    return Number.isFinite(at) ? Math.min(now, at) : now - inputLatencyMs;
  };
}

/* Used when AudioWorklet cannot start. Older mobile browsers expose the
   worklet object but refuse addModule, and this path still produces PCM. */
function attachScriptProcessor(context: AudioContext, source: MediaStreamAudioSourceNode, onChunk: PcmChunkHandler, capturedAt: (contextSeconds?: number) => number) {
  const factory = context as AudioContext & { createScriptProcessor?: (size: number, inputs: number, outputs: number) => ScriptProcessorNode };
  if (!factory.createScriptProcessor) return null;
  const processor = factory.createScriptProcessor(4096, 1, 1);
  let pending = new Float32Array(0);
  let out = new Float32Array(FRAME * 4);
  let outLength = 0;
  processor.onaudioprocess = (event) => {
    const raw = event.inputBuffer.getChannelData(0);
    const input = new Float32Array(raw);
    const output = event.outputBuffer.getChannelData(0);
    output.fill(0);
    if (!input.length) return;
    const step = (context.sampleRate || TARGET_RATE) / TARGET_RATE;
    const merged = new Float32Array(pending.length + input.length);
    merged.set(pending, 0);
    merged.set(input, pending.length);
    let offset = 0;
    while (offset + step <= merged.length) {
      if (outLength >= out.length) {
        const grown = new Float32Array(out.length * 2);
        grown.set(out, 0);
        out = grown;
      }
      out[outLength] = average(merged, offset, offset + step);
      outLength += 1;
      offset += step;
    }
    pending = new Float32Array(merged.subarray(Math.floor(offset)));
    const rate = context.sampleRate || TARGET_RATE;
    while (outLength >= FRAME) {
      const pcm = new Int16Array(FRAME);
      for (let i = 0; i < FRAME; i += 1) {
        const sample = Math.max(-1, Math.min(1, out[i]));
        pcm[i] = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
      }
      out.copyWithin(0, FRAME, outLength);
      outLength -= FRAME;
      onChunk(pcm.buffer.slice(0), capturedAt(context.currentTime - (outLength * step + pending.length) / rate));
    }
  };
  source.connect(processor);
  processor.connect(context.destination);
  return processor;
}

export async function createPcmStream(onChunk: PcmChunkHandler, sourceType: AudioSource = 'microphone', onEnded?: () => void, deviceId?: string, onStalled?: (stalled: boolean) => void) {
  if (!navigator.mediaDevices) throw new Error('当前浏览器不支持音频采集。');
  if (sourceType === 'system' && !navigator.mediaDevices.getDisplayMedia) throw new Error('当前浏览器不支持系统声音采集，请改用麦克风。');
  if (sourceType === 'microphone' && !navigator.mediaDevices.getUserMedia) throw new Error('当前浏览器不支持麦克风采集。');
  const AudioContextCtor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) throw new Error('当前浏览器不支持实时音频处理，请使用最新版 Chrome、Edge 或 Safari。');
  /* Start the permission request before any other await so the tap still counts. */
  const mediaPromise = sourceType === 'system'
    ? navigator.mediaDevices.getDisplayMedia({ audio: true, video: true })
    : openMicrophone(deviceId);
  const context = openAudioContext(AudioContextCtor);
  const resumed = unlockContext(context);
  let media: MediaStream;
  try {
    media = await mediaPromise;
  } catch (error) {
    if (context.state !== 'closed') await context.close().catch(() => undefined);
    throw error;
  }
  if (sourceType === 'system') media.getVideoTracks().forEach((track) => track.stop());
  if (sourceType === 'system' && !media.getAudioTracks().length) {
    media.getTracks().forEach((track) => track.stop());
    if (context.state !== 'closed') await context.close().catch(() => undefined);
    throw new Error('当前浏览器或共享窗口没有提供系统声音，请选择带声音的标签页或窗口。');
  }
  media.getAudioTracks().forEach((track) => track.addEventListener('ended', () => onEnded?.(), { once: true }));
  const graph: AudioNode[] = [];
  let stopped = false;
  let stalled = false;
  /* A locked screen or a phone call suspends the context. iOS only lets it
     resume once the page is visible again, and often only from a tap. */
  const wake = () => {
    if (stopped || context.state === 'running' || context.state === 'closed') return;
    void context.resume().catch(() => undefined);
  };
  const onState = () => {
    if (stopped) return;
    const next = context.state !== 'running';
    if (next !== stalled) { stalled = next; onStalled?.(next); }
    if (next && document.visibilityState === 'visible') wake();
  };
  const onVisible = () => { if (document.visibilityState === 'visible') wake(); };
  const release = () => {
    context.removeEventListener('statechange', onState);
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('pointerdown', wake);
    graph.forEach((item) => item.disconnect());
    media.getTracks().forEach((track) => track.stop());
  };
  try {
    /* resume() can stay pending when iOS will not start audio yet. The waiter
       below is what times out and what a second tap unblocks. */
    void resumed.catch(() => undefined);
    await waitUntilRunning(context);
    const source = context.createMediaStreamSource(media);
    graph.push(source);
    const capturedAt = captureClock(context, media);
    let worklet: AudioWorkletNode | null = null;
    if ('audioWorklet' in context) {
      try {
        await context.audioWorklet.addModule('/pcm-processor.js?v=40');
        worklet = new AudioWorkletNode(context, 'pcm-16k-processor');
        worklet.port.onmessage = (event) => {
          /* A cached older worklet still posts the bare buffer. */
          const data = event.data as ArrayBuffer | { pcm?: ArrayBuffer; endTime?: number } | null;
          const chunk = data instanceof ArrayBuffer ? data : data?.pcm;
          if (!chunk?.byteLength) return;
          onChunk(chunk, capturedAt(data instanceof ArrayBuffer ? undefined : data?.endTime));
        };
        source.connect(worklet);
        /* The worklet writes silence. Connecting it directly keeps mobile
           browsers from dropping the node the way a zero-gain does. */
        worklet.connect(context.destination);
        graph.push(worklet);
      } catch {
        worklet?.disconnect();
        worklet = null;
      }
    }
    if (!worklet) {
      const processor = attachScriptProcessor(context, source, onChunk, capturedAt);
      if (!processor) throw new Error('当前浏览器不支持实时音频处理，请使用最新版 Chrome、Edge 或 Safari。');
      graph.push(processor);
    }
    context.addEventListener('statechange', onState);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pointerdown', wake);
    return { stop: async () => {
      if (stopped) return;
      stopped = true;
      release();
      if (context.state !== 'closed') await context.close();
    } };
  } catch (error) {
    stopped = true;
    release();
    if (context.state !== 'closed') await context.close().catch(() => undefined);
    throw error;
  }
}
