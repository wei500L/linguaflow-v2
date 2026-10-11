import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { access, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';

const root = new URL('../..', import.meta.url).pathname;
const apiDir = join(root, 'apps/api');
const dbName = process.env.CRASH_DB ?? 'linguaflow_crash_20261011';
const apiPort = Number(process.env.CRASH_API_PORT ?? 3107);
const sonioxPort = Number(process.env.FAKE_SONIOX_PORT ?? 4011);
const summaryPort = Number(process.env.FAKE_SUMMARY_PORT ?? 4012);
const stateFile = join(root, 'scripts/isolation/evidence/fake-state.json');
const evidenceFile = join(root, 'scripts/isolation/evidence/crash-results.json');
const email = 'crash-review@example.com';
const password = 'crash-pass-2026';
const base = `http://127.0.0.1:${apiPort}`;
const summaryBase = `http://127.0.0.1:${summaryPort}/v1`;

const children: ChildProcess[] = [];

function psql(sql: string) {
  return execFileSync('psql', ['-d', dbName, '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-c', sql], { encoding: 'utf8' }).trim();
}

function spawnNode(script: string, env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, ['--import', 'tsx', script], {
    cwd: apiDir,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true
  });
  child.stdout?.on('data', (chunk) => process.stdout.write(chunk));
  child.stderr?.on('data', (chunk) => process.stderr.write(chunk));
  children.push(child);
  return child;
}

async function waitHealth(url: string) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch { /* The process is still booting. */ }
    await delay(100);
  }
  throw new Error(`health timed out: ${url}`);
}

async function fakeCounts() {
  const response = await fetch(`http://127.0.0.1:${summaryPort}/health`);
  return await response.json() as { summaryCalls: number };
}

async function killChild(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null) return;
  try { process.kill(-child.pid, 'SIGKILL'); } catch { try { process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ } }
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(2_000)]);
}

async function startApi(extra: NodeJS.ProcessEnv = {}) {
  const child = spawnNode('src/server.ts', {
    DATABASE_URL: `postgres://oo@localhost:5432/${dbName}`,
    JWT_SECRET: 'crash-isolated-secret',
    BOOTSTRAP_EMAIL: email,
    BOOTSTRAP_PASSWORD: password,
    API_PORT: String(apiPort),
    SONIOX_API_KEY: 'fake',
    SONIOX_WS_URL: `ws://127.0.0.1:${sonioxPort}`,
    PLATFORM_SUMMARY_API_BASE: summaryBase,
    PLATFORM_SUMMARY_API_KEY: 'fake',
    PLATFORM_SUMMARY_MODEL: 'fake-summary',
    WEB_ORIGIN: 'http://localhost:5173',
    ...extra
  });
  await waitHealth(`${base}/health`);
  return child;
}

async function login() {
  const response = await fetch(`${base}/v1/auth/email/login/password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  if (!response.ok) throw new Error(`login ${response.status} ${await response.text()}`);
  const body = await response.json() as { token: string; user: { id: string } };
  psql(`update entitlements set plan = 'plus' where user_id = '${body.user.id}'`);
  return { token: body.token, userId: body.user.id };
}

async function runClass(token: string) {
  const created = await fetch(`${base}/v1/realtime/sessions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'one_way', languageA: 'zh', targetLanguage: 'en', recordAudio: false, title: '崩溃验收', shareIntent: 'personal' })
  });
  if (!created.ok) throw new Error(`session ${created.status} ${await created.text()}`);
  const session = await created.json() as { sessionId: string; websocketUrl: string; websocketProtocols: string[] };
  const socket = new WebSocket(session.websocketUrl, session.websocketProtocols);
  const messages: Array<Record<string, unknown>> = [];
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('session websocket timed out')), 15_000);
    socket.on('error', (error) => { clearTimeout(timer); reject(error); });
    socket.on('message', (data) => {
      const event = JSON.parse(data.toString()) as Record<string, unknown>;
      messages.push(event);
      if (event.type === 'ready') {
        const frame = Buffer.alloc(640);
        for (let index = 0; index < 20; index += 1) socket.send(frame);
      }
      const text = JSON.stringify(event);
      if (event.type === 'transcript' && text.includes('integral.')) socket.send(JSON.stringify({ type: 'stop' }));
      if (event.type === 'finished') { clearTimeout(timer); resolve(); }
    });
  });
  socket.close();
  const finished = messages.find((event) => event.type === 'finished');
  const transcriptId = typeof finished?.transcriptId === 'string' ? finished.transcriptId : '';
  if (!transcriptId) throw new Error(`session finished without a transcript: ${JSON.stringify(finished)}`);
  return { sessionId: session.sessionId, transcriptId, messages };
}

async function quoteAndStart(token: string, transcriptId: string, idempotencyKey: string) {
  const quoteResponse = await fetch(`${base}/v1/transcripts/${transcriptId}/summary/quote`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ template: 'classroom', provider: 'platform' })
  });
  if (!quoteResponse.ok) throw new Error(`quote ${quoteResponse.status} ${await quoteResponse.text()}`);
  const quote = await quoteResponse.json() as { seconds: number; inputHash: string; inputVersion: number };
  const start = await fetch(`${base}/v1/transcripts/${transcriptId}/summary`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ template: 'classroom', outputLanguage: '中文', provider: 'platform', idempotencyKey, inputHash: quote.inputHash, inputVersion: quote.inputVersion, quoteSeconds: quote.seconds, confirmOverwrite: true })
  });
  if (!start.ok) throw new Error(`summary ${start.status} ${await start.text()}`);
  return { quote, start: await start.json() as { status: string; duplicate?: boolean } };
}

async function waitBarrier(dir: string, point: string) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      await access(join(dir, `${point}.ready`));
      return;
    } catch { /* not yet */ }
    await delay(40);
  }
  throw new Error(`barrier ${point} did not open`);
}

function snapshot(label: string, modelCalls: number) {
  const requests = JSON.parse(psql(`select coalesce(json_agg(row_to_json(t)), '[]'::json) from (select id, status, input_hash, quote_seconds, output_markdown, output_saved_at is not null as output_saved from summary_requests order by created_at) t`));
  const ledger = JSON.parse(psql(`select coalesce(json_agg(row_to_json(t)), '[]'::json) from (select request_id, status, seconds, source from usage_ledger where kind = 'summary' order by created_at) t`));
  const notes = JSON.parse(psql(`select coalesce(json_agg(row_to_json(t)), '[]'::json) from (select id, summary_status, summary_markdown, summary_source_hash from transcripts order by created_at) t`));
  const tasks = JSON.parse(psql(`select coalesce(json_agg(row_to_json(t)), '[]'::json) from (select transcript_id, text, done from transcript_tasks order by position) t`));
  const settled = (ledger as Array<{ status: string; seconds: number }>).filter((row) => row.status === 'settled').reduce((sum, row) => sum + row.seconds, 0);
  const held = (ledger as Array<{ status: string; seconds: number }>).filter((row) => row.status === 'held').reduce((sum, row) => sum + row.seconds, 0);
  return { label, modelCalls, settledSeconds: settled, heldSeconds: held, requests, ledger, notes, tasks };
}

async function withApi(extra: NodeJS.ProcessEnv, body: (token: string) => Promise<void>) {
  const api = await startApi(extra);
  try {
    const auth = await login();
    await body(auth.token);
  } finally {
    await killChild(api);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      try {
        execFileSync('lsof', ['-nP', `-iTCP:${apiPort}`, '-sTCP:LISTEN'], { stdio: 'ignore' });
        await delay(50);
      } catch { break; }
    }
  }
}

async function main() {
  execFileSync('dropdb', ['--if-exists', dbName]);
  execFileSync('createdb', [dbName]);
  execFileSync(join(apiDir, 'node_modules/.bin/drizzle-kit'), ['migrate'], {
    cwd: apiDir,
    env: { ...process.env, DATABASE_URL: `postgres://oo@localhost:5432/${dbName}` },
    stdio: 'inherit'
  });
  await mkdir(join(root, 'scripts/isolation/evidence'), { recursive: true });
  const fake = spawnNode('test/fakes/local-services.ts', {
    FAKE_SONIOX_PORT: String(sonioxPort),
    FAKE_SUMMARY_PORT: String(summaryPort),
    FAKE_STATE_FILE: stateFile
  });
  await waitHealth(`http://127.0.0.1:${summaryPort}/health`);
  const results: unknown[] = [];
  try {
    const barrierHeld = join(root, 'scripts/isolation/evidence/barrier-held');
    await rm(barrierHeld, { recursive: true, force: true });
    let transcriptId = '';
    await withApi({ LINGUAFLOW_BARRIER: 'summary-held', LINGUAFLOW_BARRIER_DIR: barrierHeld }, async (token) => {
      const session = await runClass(token);
      transcriptId = session.transcriptId;
      const before = await fakeCounts();
      await quoteAndStart(token, transcriptId, 'crash-held-0001');
      await waitBarrier(barrierHeld, 'summary-held');
      results.push({ ...snapshot('held-before-kill', (await fakeCounts()).summaryCalls - before.summaryCalls), transcriptId });
    });
    await withApi({}, async (token) => {
      const calls = await fakeCounts();
      const replay = await quoteAndStart(token, transcriptId, 'crash-held-0001');
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const status = psql(`select summary_status from transcripts where id = '${transcriptId}'`);
        if (status === 'ready') break;
        await delay(100);
      }
      results.push({ ...snapshot('held-replayed', (await fakeCounts()).summaryCalls - calls.summaryCalls), replay });
    });

    const barrierOutput = join(root, 'scripts/isolation/evidence/barrier-output');
    await rm(barrierOutput, { recursive: true, force: true });
    await withApi({ LINGUAFLOW_FAIL_SUMMARY_TASKS: '1', LINGUAFLOW_BARRIER: 'summary-output-persisted', LINGUAFLOW_BARRIER_DIR: barrierOutput }, async (token) => {
      const calls = await fakeCounts();
      await quoteAndStart(token, transcriptId, 'crash-output-0002');
      await waitBarrier(barrierOutput, 'summary-output-persisted');
      results.push(snapshot('output-persisted-before-kill', (await fakeCounts()).summaryCalls - calls.summaryCalls));
    });
    await withApi({ LINGUAFLOW_FAIL_SUMMARY_TASKS: '1' }, async () => {
      await delay(400);
      results.push(snapshot('task-repair-still-failing', 0));
    });
    await withApi({}, async () => {
      const calls = await fakeCounts();
      await delay(500);
      results.push(snapshot('task-repair-recovered', (await fakeCounts()).summaryCalls - calls.summaryCalls));
    });

    const barrierBefore = join(root, 'scripts/isolation/evidence/barrier-before');
    await rm(barrierBefore, { recursive: true, force: true });
    let secondTranscript = '';
    await withApi({}, async (token) => {
      const session = await runClass(token);
      secondTranscript = session.transcriptId;
      const calls = await fakeCounts();
      await quoteAndStart(token, secondTranscript, 'crash-note-a');
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        if (psql(`select summary_status from transcripts where id = '${secondTranscript}'`) === 'ready') break;
        await delay(100);
      }
      results.push(snapshot('note-a-ready', (await fakeCounts()).summaryCalls - calls.summaryCalls));
    });
    await withApi({ LINGUAFLOW_FAIL_SUMMARY_TASKS: '1', LINGUAFLOW_BARRIER: 'summary-before-commit', LINGUAFLOW_BARRIER_DIR: barrierBefore }, async (token) => {
      const calls = await fakeCounts();
      await quoteAndStart(token, secondTranscript, 'crash-note-b');
      await waitBarrier(barrierBefore, 'summary-before-commit');
      results.push(snapshot('before-commit-kill', (await fakeCounts()).summaryCalls - calls.summaryCalls));
    });
    await withApi({}, async (token) => {
      const calls = await fakeCounts();
      const replay = await quoteAndStart(token, secondTranscript, 'crash-note-b');
      await delay(600);
      results.push({ ...snapshot('note-b-recovered', (await fakeCounts()).summaryCalls - calls.summaryCalls), replay });
    });

    const barrierAfter = join(root, 'scripts/isolation/evidence/barrier-after');
    await rm(barrierAfter, { recursive: true, force: true });
    await withApi({ LINGUAFLOW_BARRIER: 'summary-committed', LINGUAFLOW_BARRIER_DIR: barrierAfter }, async (token) => {
      const session = await runClass(token);
      const calls = await fakeCounts();
      await quoteAndStart(token, session.transcriptId, 'crash-after-0003');
      await waitBarrier(barrierAfter, 'summary-committed');
      results.push({ ...snapshot('after-commit-before-client', (await fakeCounts()).summaryCalls - calls.summaryCalls), transcriptId: session.transcriptId });
    });
    await withApi({}, async (token) => {
      const calls = await fakeCounts();
      const replay = await quoteAndStart(token, String((results.at(-1) as { transcriptId: string }).transcriptId), 'crash-after-0003');
      results.push({ ...snapshot('after-commit-replay', (await fakeCounts()).summaryCalls - calls.summaryCalls), replay });
    });

    const byLabel = Object.fromEntries((results as Array<{ label: string }>).map((item) => [item.label, item])) as Record<string, {
      modelCalls: number; settledSeconds: number; heldSeconds: number;
      requests: Array<{ status: string; output_markdown: string | null }>;
      notes: Array<{ summary_status: string; summary_markdown: string | null }>;
      tasks: Array<{ text: string }>;
      replay?: { start: { status: string; duplicate?: boolean } };
    }>;
    const expect = (label: string, check: (row: (typeof byLabel)[string]) => void) => check(byLabel[label]);
    expect('held-before-kill', (row) => {
      if (row.modelCalls !== 0 || row.settledSeconds !== 0 || row.heldSeconds !== 60) throw new Error('held before model was treated as finished');
      if (row.requests[0]?.output_markdown || row.notes[0]?.summary_markdown) throw new Error('a missing model result was stored as a note');
    });
    expect('held-replayed', (row) => {
      if (row.modelCalls !== 1 || row.settledSeconds !== 60 || row.heldSeconds !== 0) throw new Error('replay did not settle the 60 second hold once');
      if (!row.notes[0]?.summary_markdown?.includes('版本 1') || row.tasks[0]?.text !== '待办1') throw new Error('replay did not keep the produced note');
    });
    expect('output-persisted-before-kill', (row) => {
      if (row.modelCalls !== 1 || row.heldSeconds !== 60 || row.settledSeconds !== 60) throw new Error('persisted output changed the ledger early');
      if (!row.requests[1]?.output_markdown?.includes('版本 2') || row.requests[1]?.status !== 'running') throw new Error('the new output was not kept on its own request');
      if (!row.notes[0]?.summary_markdown?.includes('版本 1')) throw new Error('the previous note was replaced before commit');
    });
    expect('task-repair-still-failing', (row) => {
      if (row.modelCalls !== 0 || row.requests[1]?.status !== 'running' || row.heldSeconds !== 60) throw new Error('a failed task repair was marked ready or charged again');
      if (!row.notes[0]?.summary_markdown?.includes('版本 1')) throw new Error('failed repair published the new note');
    });
    expect('task-repair-recovered', (row) => {
      if (row.modelCalls !== 0 || row.settledSeconds !== 120 || row.heldSeconds !== 0) throw new Error('recovery called the model or settled twice');
      if (!row.notes[0]?.summary_markdown?.includes('版本 2') || row.tasks[0]?.text !== '待办2') throw new Error('recovery restored the old note instead of this attempt');
    });
    expect('before-commit-kill', (row) => {
      if (row.modelCalls !== 1 || row.settledSeconds !== 180 || row.heldSeconds !== 60) throw new Error('the open transaction settled or dropped the hold');
      if (!row.notes[1]?.summary_markdown?.includes('版本 3') || row.notes[1]?.summary_status !== 'running') throw new Error('the note changed before commit');
      if (!row.requests[3]?.output_markdown?.includes('版本 4') || row.requests[3]?.status !== 'running') throw new Error('the attempt output was lost');
    });
    expect('note-b-recovered', (row) => {
      if (row.modelCalls !== 0 || row.replay?.start.duplicate !== true || row.settledSeconds !== 240) throw new Error('recovering B called the model or charged again');
      if (!row.notes[1]?.summary_markdown?.includes('版本 4') || row.tasks[1]?.text !== '待办4') throw new Error('recovery completed B with note A');
    });
    expect('after-commit-replay', (row) => {
      if (row.modelCalls !== 0 || row.replay?.start.status !== 'ready' || row.replay?.start.duplicate !== true || row.settledSeconds !== 300 || row.heldSeconds !== 0) throw new Error('replaying a committed summary called the model or changed the ledger');
    });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(evidenceFile, JSON.stringify(results, null, 2));
    console.log('crash assertions passed');
  } finally {
    for (const child of children) await killChild(child);
  }
}

main().catch(async (error) => {
  console.error(error);
  for (const child of children) await killChild(child);
  process.exit(1);
});
