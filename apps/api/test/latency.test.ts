import assert from 'node:assert/strict';
import test from 'node:test';
import { trimQueuedAudio } from '../../web/src/lib/audio.ts';
import { alignSentAudio, chunkDurationMs, commitSentChunk, createLatencyClock, latencyAt, latencyBand, newestTokenEndMs, observeTranscript, readLatency, readoutBand, sameReadout, smoothLatency, stampChunk, startMeasuring } from '../../web/src/lib/latency.ts';

function clockWith(chunks: Array<[durationMs: number, capturedAt: number]>) {
  const clock = createLatencyClock();
  for (const [durationMs, capturedAt] of chunks) commitSentChunk(clock, { durationMs, capturedAt });
  return clock;
}

test('pcm duration is one millisecond per 32 bytes', () => {
  assert.equal(chunkDurationMs(3840), 120);
  assert.equal(chunkDurationMs(1280), 40);
  assert.equal(chunkDurationMs(0), 0);
  assert.equal(chunkDurationMs(-32), 0);
});

test('a shorter frame still keeps twenty-four seconds of unsent speech', () => {
  const frames = Array.from({ length: 700 }, () => ({ durationMs: 40 }));
  trimQueuedAudio(frames);
  assert.equal(frames.length, 600);
  assert.equal(frames.reduce((sum, frame) => sum + frame.durationMs, 0), 24_000);
  const legacy = Array.from({ length: 200 }, () => ({ durationMs: 120 }));
  trimQueuedAudio(legacy);
  assert.equal(legacy.length, 200);
});

test('the audio clock moves only after a chunk is committed as sent', () => {
  const clock = createLatencyClock();
  const stamped = stampChunk(3200, 1_000);
  assert.equal(stamped.durationMs, 100);
  assert.equal(clock.sentAudioMs, 0);
  commitSentChunk(clock, stamped);
  assert.equal(clock.sentAudioMs, 100);
  commitSentChunk(clock, stampChunk(0, 1_100));
  assert.equal(clock.sentAudioMs, 100);
});

test('latency is the delay from the captured audio position to now', () => {
  const clock = clockWith([[100, 100], [100, 5_000]]);
  assert.equal(latencyAt(clock, 50, 5_100), 5_050);
  assert.equal(latencyAt(clock, 150, 5_100), 150);
  assert.equal(latencyAt(clock, 100, 5_100), 5_000);
});

test('positions past the sent audio are clamped to its end', () => {
  const clock = clockWith([[120, 1_000]]);
  assert.equal(latencyAt(clock, 500, 1_300), 300);
  assert.equal(latencyAt(clock, 120, 900), 0);
});

test('marks older than three minutes are dropped', () => {
  const clock = clockWith([[100, 100], [180_001, 180_101]]);
  assert.equal(clock.marks.length, 1);
  assert.equal(latencyAt(clock, 50, 180_101), null);
  assert.equal(latencyAt(clock, 180_000, 180_201), 201);
});

test('audio lost with a closed socket is cut so the timeline matches what Soniox heard', () => {
  const clock = clockWith([[100, 1_100], [100, 1_200], [100, 1_300]]);
  alignSentAudio(clock, 150);
  assert.equal(clock.sentAudioMs, 150);
  assert.equal(clock.marks.length, 2);
  assert.deepEqual(clock.marks[1], { audioEndMs: 150, durationMs: 50, capturedAt: 1_150 });
  commitSentChunk(clock, { durationMs: 100, capturedAt: 2_000 });
  assert.equal(latencyAt(clock, 250, 2_400), 400);
  alignSentAudio(clock, 999);
  assert.equal(clock.sentAudioMs, 250);
});

test('audio captured before the session was ready only measures the startup backlog', () => {
  const clock = clockWith([[1_000, 1_000]]);
  startMeasuring(clock, 1_500);
  commitSentChunk(clock, { durationMs: 1_000, capturedAt: 2_000 });
  assert.equal(latencyAt(clock, 800, 3_000), null);
  assert.equal(latencyAt(clock, 2_000, 2_300), 300);
});

test('processed audio drives recognition, and a repeated word end does not inflate it', () => {
  const clock = clockWith([[5_000, 5_000]]);
  observeTranscript(clock, { tokens: [{ text: 'Hello', end_ms: 760, translation_status: 'original' }], totalAudioProcMs: 880 }, 1_000);
  assert.equal(clock.recognition.cursorMs, 880);
  assert.equal(clock.recognition.smooth, 120);
  observeTranscript(clock, { tokens: [{ text: 'Hello', end_ms: 760 }], totalAudioProcMs: 880 }, 1_800);
  assert.equal(clock.recognition.smooth, 120);
  assert.equal(clock.recognition.sampledAt, 1_000);
  const fallback = clockWith([[5_000, 5_000]]);
  observeTranscript(fallback, { tokens: [{ text: 'Hello', end_ms: 760 }, { text: '你好', translation_status: 'translation' }] }, 1_000);
  assert.equal(fallback.recognition.cursorMs, 760);
});

test('translation latency follows the spoken tokens that come before it', () => {
  const clock = clockWith([[5_000, 5_000]]);
  observeTranscript(clock, {
    tokens: [
      { text: 'Good', end_ms: 400, is_final: true, translation_status: 'original' },
      { text: ' morning', end_ms: 900, is_final: true, translation_status: 'original' },
      { text: ' every', end_ms: 1_300, is_final: false, translation_status: 'original' }
    ],
    totalAudioProcMs: 1_400
  }, 1_500);
  assert.equal(clock.finalSourceEndMs, 900);
  assert.equal(clock.translation.cursorMs, null);
  observeTranscript(clock, { tokens: [{ text: '早上好', is_final: true, translation_status: 'translation' }], totalAudioProcMs: 1_500 }, 2_400);
  assert.equal(clock.translation.cursorMs, 900);
  assert.equal(clock.translation.smooth, 1_500);
  const interim = clockWith([[5_000, 5_000]]);
  observeTranscript(interim, { tokens: [{ text: 'Hi', end_ms: 300, is_final: false }, { text: '嗨', is_final: false, translation_status: 'translation' }] }, 800);
  assert.equal(interim.translation.cursorMs, 300);
});

test('untranslatable speech does not leave a translation waiting', () => {
  const clock = clockWith([[5_000, 5_000]]);
  observeTranscript(clock, { tokens: [{ text: 'Bonjour', end_ms: 600, is_final: true, translation_status: 'none' }], totalAudioProcMs: 700 }, 1_000);
  assert.equal(clock.finalSourceEndMs, null);
  assert.equal(readLatency(clock, 9_000, true).translation, null);
});

test('smoothing is time based, so frequent results do not make the number jump', () => {
  assert.equal(smoothLatency(null, 100, 50), 100);
  assert.ok(Math.abs(smoothLatency(100, 1_100, 100) - (100 + 1_000 * (1 - Math.exp(-0.1)))) < 1e-9);
  assert.ok(smoothLatency(100, 1_100, 10_000) > 1_099);
  const clock = clockWith([[10_000, 10_000]]);
  observeTranscript(clock, { tokens: [], totalAudioProcMs: 1_000 }, 1_200);
  observeTranscript(clock, { tokens: [], totalAudioProcMs: 1_100 }, 2_300);
  const smooth = clock.recognition.smooth ?? 0;
  assert.ok(smooth > 200 && smooth < 1_200);
});

test('a stalled connection makes the readout rise while capture is active', () => {
  const clock = clockWith([[1_000, 1_000]]);
  startMeasuring(clock, 0);
  observeTranscript(clock, { tokens: [], totalAudioProcMs: 500 }, 800);
  assert.equal(readLatency(clock, 900, true).recognition, 300);
  commitSentChunk(clock, { durationMs: 2_000, capturedAt: 3_000 });
  assert.equal(readLatency(clock, 1_900, true).recognition, 300);
  assert.equal(readLatency(clock, 4_500, true).recognition, 4_000);
  assert.equal(readLatency(clock, 4_500, false).recognition, 300);
});

test('a session with no result yet starts rising once the wait is long', () => {
  const clock = createLatencyClock();
  startMeasuring(clock, 1_000);
  commitSentChunk(clock, { durationMs: 120, capturedAt: 1_120 });
  commitSentChunk(clock, { durationMs: 600, capturedAt: 1_720 });
  assert.equal(readLatency(clock, 1_800, true).recognition, null);
  assert.equal(readLatency(clock, 4_000, true).recognition, 2_880);
});

test('a batch picks the newest spoken timestamp and skips endpoints and translations', () => {
  assert.equal(newestTokenEndMs([
    { text: '你好', end_ms: 400 },
    { text: '<end>', end_ms: 900 },
    { text: '世界', end_ms: 700 },
    { text: 'world', end_ms: 1_200, translation_status: 'translation' },
    { text: '…' }
  ]), 700);
  assert.equal(newestTokenEndMs([{ text: '<end>' }]), null);
});

test('latency bands give translation a wider budget and the badge takes the worse one', () => {
  assert.equal(latencyBand(null), 'pending');
  assert.equal(latencyBand(799), 'ok');
  assert.equal(latencyBand(800), 'warn');
  assert.equal(latencyBand(2000), 'slow');
  assert.equal(latencyBand(2000, 'translation'), 'ok');
  assert.equal(latencyBand(5000, 'translation'), 'slow');
  assert.equal(readoutBand({ recognition: 300, translation: 3_000 }), 'warn');
  assert.equal(readoutBand({ recognition: 2_500, translation: 1_000 }), 'slow');
  assert.ok(sameReadout({ recognition: 301, translation: null }, { recognition: 304, translation: null }));
  assert.ok(!sameReadout({ recognition: 300, translation: null }, { recognition: 300, translation: 900 }));
});
