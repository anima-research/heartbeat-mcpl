import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McplConnection } from '@animalabs/mcpl-core';
import type { PushEventParams } from '@animalabs/mcpl-core';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BUILT = join(ROOT, 'dist', 'src', 'index.js');
export const CEILING_MS = 60_000;
export const POLICY = { effectiveCapabilities: ['tools', 'pushEvents'], deniedCapabilities: [], enabled: ['heartbeat'], disabled: [] };
export const origin = (p: PushEventParams) => (p.origin ?? {}) as Record<string, unknown>;

export type PushAnswer = { error?: [number, string]; result?: unknown };

export async function logged(h: { stderr: () => string }, line: string) {
  const deadline = Date.now() + CEILING_MS;
  while (!h.stderr().split('\n').includes(`[heartbeat-mcpl] ${line}`)) {
    assert.ok(Date.now() < deadline, `expected the log line\n${line}\nin\n${h.stderr()}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

export interface ServerFiles { dir: string; reminders: string; config: string; }

export async function serverWithHost(
  answerPush: (p: PushEventParams) => PushAnswer | Promise<PushAnswer>,
  { reminders = [] as unknown[], mcpl = true, policy = true, env = {} as Record<string, string>, prepare = (_files: ServerFiles) => {}, viaSymlink = false } = {},
) {
  const src = join(ROOT, 'src');
  const builtAt = (() => { try { return statSync(BUILT).mtimeMs; } catch { return 0; } })();
  assert.ok(readdirSync(src).every((f) => statSync(join(src, f)).mtimeMs <= builtAt),
    `${BUILT} is missing or older than src/; run npm run build first (npm test does)`);
  const dir = mkdtempSync(join(tmpdir(), 'hb-scripted-host-'));
  const remindersFile = join(dir, 'reminders.json');
  const files: ServerFiles = { dir, reminders: remindersFile, config: join(dir, 'config.json') };
  writeFileSync(remindersFile, JSON.stringify(reminders));
  prepare(files);
  const entry = viaSymlink ? join(dir, 'heartbeat-mcpl') : BUILT;
  if (viaSymlink) symlinkSync(BUILT, entry);
  const child = spawn(process.execPath, [entry, '--stdio'], {
    cwd: tmpdir(),
    env: { ...process.env, ...env, HEARTBEAT_CONFIG_FILE: files.config, HEARTBEAT_REMINDERS_FILE: remindersFile },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (b) => { stderr += String(b); });
  const out: Buffer[] = [];
  child.stdout.on('data', (b: Buffer) => { out.push(b); });
  let exitCode: number | null = null;
  child.on('exit', (code) => { exitCode = code; });
  // 'close' comes once the process has exited and its output has all been
  // read, so a test that reads stderr after it sees every line.
  const exited = new Promise<void>((resolve) => child.on('close', () => resolve()));
  const conn = McplConnection.fromStreams(child.stdout, child.stdin);
  const pushes: PushEventParams[] = [];
  const pushWaiters: Array<() => void> = [];
  void (async () => {
    try {
      for (;;) {
        const msg = await conn.nextMessage();
        if (msg.type !== 'request' || msg.request.method !== 'push/event') continue;
        const p = msg.request.params as PushEventParams;
        const { id } = msg.request;
        pushes.push(p);
        const send = (answer: PushAnswer) => {
          if (answer.error) conn.sendError(id, ...answer.error);
          else conn.sendResponse(id, answer.result ?? { accepted: true, inferenceId: 'i' });
        };
        const answer = answerPush(p);
        if (answer instanceof Promise) void answer.then(send);
        else send(answer);
        pushWaiters.splice(0).forEach((w) => w());
      }
    } catch (e) {
      if ((e as Error).name !== 'ConnectionClosedError') throw e;
    }
  })();
  const request = (method: string, params: unknown) => conn.sendRequest(method, params, CEILING_MS);
  let serverInfo: { name: string; version: string };
  try {
    ({ serverInfo } = await conn.sendRequest('initialize', {
      protocolVersion: '2024-11-05', capabilities: mcpl ? { experimental: { mcpl: { version: '0.5', pushEvents: true } } } : {},
      clientInfo: { name: 'test-host', version: '0' },
    }, CEILING_MS) as { serverInfo: { name: string; version: string } });
    if (mcpl && policy) await request('featureSets/update', POLICY);
  } catch (e) {
    conn.close();
    child.kill();
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  const notify = (method: string, params: unknown) => conn.sendNotification(method, params);
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    ((await request('tools/call', { name, arguments: args })) as { content: Array<{ text: string }> }).content[0]!.text;
  const pushCount = async (n: number) => {
    const deadline = Date.now() + CEILING_MS;
    while (pushes.length < n) {
      assert.ok(Date.now() < deadline, `expected ${n} push/event(s), saw ${pushes.length}`);
      await new Promise<void>((r) => { pushWaiters.push(r); setTimeout(r, 100); });
    }
  };
  const close = () => { conn.close(); child.kill(); rmSync(dir, { recursive: true, force: true }); };
  const hangUp = () => { conn.close(); return exited; };
  const crash = () => { child.kill('SIGKILL'); return exited; };
  const stored = () => JSON.parse(readFileSync(remindersFile, 'utf8')) as Array<Record<string, unknown>>;
  const rawOut = () => Buffer.concat(out).toString('utf8');
  const writeRaw = (text: string) => { child.stdin.write(text); };
  return {
    pushes, call, request, notify, pushCount, stored, stderr: () => stderr, close, hangUp, crash, files, serverInfo,
    rawOut, writeRaw, exited, exitCode: () => exitCode, child,
  };
}
