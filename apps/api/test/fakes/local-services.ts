import http from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';

export type FakeState = {
  summaryCalls: number;
  sonioxSessions: number;
  audioBytes: number;
  failSummary: boolean;
  summaryDelayMs: number;
};

export async function writeFakeState(file: string, state: FakeState) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(state));
}

export function startLocalServices(options: { sonioxPort: number; summaryPort: number; stateFile: string }) {
  const state: FakeState = { summaryCalls: 0, sonioxSessions: 0, audioBytes: 0, failSummary: false, summaryDelayMs: 0 };
  const persist = () => { void writeFakeState(options.stateFile, state); };
  const soniox = new WebSocketServer({ port: options.sonioxPort });
  soniox.on('connection', (socket) => {
    state.sonioxSessions += 1;
    persist();
    let announced = false;
    const lesson = () => {
      if (announced || socket.readyState !== WebSocket.OPEN) return;
      announced = true;
      socket.send(JSON.stringify({ tokens: [{ text: '积', is_final: false, speaker: '1', language: 'zh', start_ms: 0, end_ms: 200 }] }));
      socket.send(JSON.stringify({
        tokens: [{ text: '积分。', is_final: true, speaker: '1', language: 'zh', start_ms: 0, end_ms: 800, translation_status: 'original' }],
        total_audio_proc_ms: 800
      }));
      setTimeout(() => {
        if (socket.readyState !== WebSocket.OPEN) return;
        socket.send(JSON.stringify({
          tokens: [{ text: 'integral.', is_final: true, translation_status: 'translation', source_language: 'zh', speaker: '1', start_ms: 0, end_ms: 800 }],
          total_audio_proc_ms: 900
        }));
        socket.send(JSON.stringify({ tokens: [{ text: '<end>', is_final: true }], total_audio_proc_ms: 900 }));
      }, 40);
    };
    socket.on('message', (data, isBinary) => {
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      if (isBinary) {
        state.audioBytes += buffer.length;
        persist();
        if (state.audioBytes >= 3200) lesson();
        return;
      }
      const text = buffer.toString('utf8');
      if (text === '') {
        lesson();
        setTimeout(() => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ finished: true })); }, 80);
      }
    });
  });
  const summary = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(state));
      return;
    }
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const finish = () => {
        if (state.failSummary) {
          response.writeHead(500, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: 'injected' }));
          return;
        }
        state.summaryCalls += 1;
        persist();
        const segment = body.match(/\[\[seg:([0-9a-f-]{36})\]\]/i)?.[1];
        const cite = segment ? ` [[seg:${segment}]]` : '';
        const content = `## 课程主题\n版本 ${state.summaryCalls}${cite}\n\n## 待办事项\n- 待办${state.summaryCalls}`;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ message: { content } }] }));
      };
      if (state.summaryDelayMs > 0) setTimeout(finish, state.summaryDelayMs);
      else finish();
    });
  });
  summary.listen(options.summaryPort);
  persist();
  return { state, soniox, summary };
}

const sonioxPort = Number(process.env.FAKE_SONIOX_PORT ?? 4011);
const summaryPort = Number(process.env.FAKE_SUMMARY_PORT ?? 4012);
const stateFile = process.env.FAKE_STATE_FILE ?? '/tmp/linguaflow-fake-state.json';
if (process.argv[1]?.endsWith('local-services.ts')) {
  startLocalServices({ sonioxPort, summaryPort, stateFile });
  console.log(`fake soniox ws://127.0.0.1:${sonioxPort}`);
  console.log(`fake summary http://127.0.0.1:${summaryPort}/v1`);
}
