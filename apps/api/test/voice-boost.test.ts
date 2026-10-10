import assert from 'node:assert/strict';
import test from 'node:test';
import { VoiceBoost } from '../../web/src/lib/voice-boost.ts';

function rms(pcm: ArrayBuffer) {
  const samples = new Int16Array(pcm);
  let energy = 0;
  for (const sample of samples) {
    const value = sample < 0 ? sample / 0x8000 : sample / 0x7fff;
    energy += value * value;
  }
  return Math.sqrt(energy / samples.length);
}

function sine(freq: number, amplitude: number, phase: { n: number }) {
  const pcm = new Int16Array(640);
  const step = (2 * Math.PI * freq) / 16_000;
  for (let i = 0; i < pcm.length; i += 1) {
    const sample = Math.sin(phase.n) * amplitude;
    phase.n += step;
    pcm[i] = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
  }
  return pcm.buffer;
}

function run(boost: VoiceBoost, freq: number, amplitude: number, frames: number, enabled = true) {
  const phase = { n: 0 };
  let input = sine(freq, amplitude, phase);
  let output = input;
  for (let i = 0; i < frames; i += 1) {
    input = sine(freq, amplitude, phase);
    output = boost.process(input, enabled);
  }
  return { input, output };
}

test('voice boost leaves the buffer untouched while it is off', () => {
  const boost = new VoiceBoost();
  const frame = sine(440, 0.2, { n: 0.4 });
  assert.equal(boost.process(frame, false), frame);
  assert.equal(boost.process(new ArrayBuffer(0), true).byteLength, 0);
  assert.equal(boost.process(new ArrayBuffer(3), true).byteLength, 3);
});

test('voice boost lifts a quiet voice that sits above the room', () => {
  const boost = new VoiceBoost();
  const phase = { n: 0 };
  for (let i = 0; i < 8; i += 1) boost.process(sine(180, 0.0012, phase), true);
  let speechIn = 0;
  let speechOut = 0;
  for (let i = 0; i < 24; i += 1) {
    const speaking = i % 5 < 3;
    const frame = sine(220, speaking ? 0.02 : 0.0012, phase);
    const output = boost.process(frame, true);
    if (speaking && i > 12) {
      speechIn = rms(frame);
      speechOut = rms(output);
    }
    for (const sample of new Int16Array(output)) assert.ok(sample >= -32768 && sample <= 32767);
  }
  assert.ok(speechOut > speechIn * 2.2, `quiet speech ${speechIn} should be lifted, got ${speechOut}`);
  assert.ok(speechOut < 0.2, `lifted speech should stay below clipping, got ${speechOut}`);
});

test('voice boost does not lift a steady room tone', () => {
  const { input, output } = run(new VoiceBoost(), 300, 0.008, 48);
  const inputLevel = rms(input);
  const outputLevel = rms(output);
  assert.ok(outputLevel < inputLevel * 1.45, `room tone ${inputLevel} became ${outputLevel}`);
});

test('voice boost softens low rumble and keeps the speech band', () => {
  const rumble = run(new VoiceBoost(), 35, 0.3, 20);
  const voice = run(new VoiceBoost(), 1000, 0.2, 20);
  const rumbleRatio = rms(rumble.output) / rms(rumble.input);
  const voiceRatio = rms(voice.output) / rms(voice.input);
  assert.ok(rumbleRatio < 0.35, `35 Hz should be cut, ratio ${rumbleRatio}`);
  assert.ok(voiceRatio > 0.75, `1 kHz should pass, ratio ${voiceRatio}`);
});

test('voice boost keeps lifting speech that continues without a long pause', () => {
  const boost = new VoiceBoost();
  const phase = { n: 0 };
  for (let i = 0; i < 10; i += 1) boost.process(sine(180, 0.001, phase), true);
  let inputLevel = 0;
  let outputLevel = 0;
  for (let i = 0; i < 100; i += 1) {
    const frame = sine(240, i % 2 === 0 ? 0.018 : 0.03, phase);
    const output = boost.process(frame, true);
    inputLevel = rms(frame);
    outputLevel = rms(output);
  }
  assert.ok(outputLevel > inputLevel * 2, `continuous speech ${inputLevel} collapsed to ${outputLevel}`);
});

test('a steady noise that arrives after silence does not stay boosted', () => {
  const boost = new VoiceBoost();
  const phase = { n: 0 };
  for (let i = 0; i < 10; i += 1) boost.process(sine(180, 0.001, phase), true);
  let inputLevel = 0;
  let outputLevel = 0;
  for (let i = 0; i < 80; i += 1) {
    const frame = sine(300, 0.02, phase);
    const output = boost.process(frame, true);
    inputLevel = rms(frame);
    outputLevel = rms(output);
  }
  assert.ok(outputLevel < inputLevel * 1.7, `steady noise ${inputLevel} stayed at ${outputLevel}`);
});

test('one silent frame does not make the following room tone get lifted', () => {
  const boost = new VoiceBoost();
  const phase = { n: 0 };
  for (let i = 0; i < 30; i += 1) boost.process(sine(300, 0.01, phase), true);
  boost.process(new Int16Array(640).buffer, true);
  let inputLevel = 0;
  let outputLevel = 0;
  for (let i = 0; i < 20; i += 1) {
    const frame = sine(300, 0.01, phase);
    const output = boost.process(frame, true);
    inputLevel = rms(frame);
    outputLevel = rms(output);
  }
  assert.ok(outputLevel < inputLevel * 1.7, `after a dropout ${inputLevel} became ${outputLevel}`);
});

test('a loud sound right after quiet speech is not driven into the limiter', () => {
  const boost = new VoiceBoost();
  const phase = { n: 0 };
  for (let i = 0; i < 10; i += 1) boost.process(sine(180, 0.001, phase), true);
  for (let i = 0; i < 30; i += 1) boost.process(sine(240, i % 2 ? 0.012 : 0.008, phase), true);
  for (let frame = 0; frame < 3; frame += 1) {
    let peak = 0;
    for (const sample of new Int16Array(boost.process(sine(500, 0.5, phase), true))) peak = Math.max(peak, Math.abs(sample) / 0x8000);
    assert.ok(peak < 0.8, `loud frame ${frame} peaked at ${peak}`);
  }
});

test('reset forgets gain from the previous capture', () => {
  const boost = new VoiceBoost();
  const phase = { n: 0 };
  for (let i = 0; i < 8; i += 1) boost.process(sine(180, 0.001, phase), true);
  for (let i = 0; i < 30; i += 1) boost.process(sine(240, i % 2 === 0 ? 0.02 : 0.032, phase), true);
  boost.reset();
  const frame = sine(1000, 0.2, phase);
  const output = boost.process(frame, true);
  assert.ok(rms(output) < rms(frame) * 1.4, `after reset ${rms(frame)} became ${rms(output)}`);
});

test('turning voice boost off returns the original samples', () => {
  const boost = new VoiceBoost();
  const phase = { n: 1 };
  for (let i = 0; i < 10; i += 1) boost.process(sine(220, 0.02, phase), true);
  for (let i = 0; i < 14; i += 1) boost.process(sine(220, 0.02, phase), false);
  const frame = sine(440, 0.15, phase);
  assert.equal(boost.process(frame, false), frame);
});
