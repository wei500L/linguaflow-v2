export type AudioSource = 'microphone' | 'system';

export async function listAudioInputs() {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((device) => device.kind === 'audioinput' && device.deviceId).map((device, index) => ({ id: device.deviceId, label: device.label || `Microphone ${index + 1}` }));
}

export async function createPcmStream(onChunk: (chunk: ArrayBuffer) => void, sourceType: AudioSource = 'microphone', onEnded?: () => void, deviceId?: string) {
  if (!navigator.mediaDevices) throw new Error('当前浏览器不支持音频采集。');
  if (sourceType === 'system' && !navigator.mediaDevices.getDisplayMedia) throw new Error('当前浏览器不支持系统声音采集，请改用麦克风。');
  if (sourceType === 'microphone' && !navigator.mediaDevices.getUserMedia) throw new Error('当前浏览器不支持麦克风采集。');
  if (!('AudioContext' in window) || !('audioWorklet' in AudioContext.prototype)) throw new Error('当前浏览器不支持实时音频处理，请使用最新版 Chrome、Edge 或 Safari。');
  const context = new AudioContext({ latencyHint: 'interactive' });
  const resumed = context.resume();
  let media: MediaStream;
  try {
    media = sourceType === 'system'
      ? await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true })
      : await navigator.mediaDevices.getUserMedia({ audio: { deviceId: deviceId ? { exact: deviceId } : undefined, channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
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
  let source: MediaStreamAudioSourceNode | null = null;
  let node: AudioWorkletNode | null = null;
  let stopped = false;
  try {
    await resumed;
    if (context.state === 'suspended') await context.resume();
    await context.audioWorklet.addModule('/pcm-processor.js');
    source = context.createMediaStreamSource(media);
    node = new AudioWorkletNode(context, 'pcm-16k-processor');
    node.port.onmessage = (event) => onChunk(event.data as ArrayBuffer);
    const sink = context.createGain();
    sink.gain.value = 0;
    source.connect(node);
    node.connect(sink);
    sink.connect(context.destination);
    return { stop: async () => {
      if (stopped) return;
      stopped = true;
      node?.disconnect();
      source?.disconnect();
      media.getTracks().forEach((track) => track.stop());
      if (context && context.state !== 'closed') await context.close();
    } };
  } catch (error) {
    node?.disconnect();
    source?.disconnect();
    media.getTracks().forEach((track) => track.stop());
    if (context && context.state !== 'closed') await context.close().catch(() => undefined);
    throw error;
  }
}
