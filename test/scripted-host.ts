import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McplConnection } from '@animalabs/mcpl-core';
import type { PushEventParams } from '@animalabs/mcpl-core';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const POLICY = { effectiveCapabilities: ['tools', 'pushEvents'], deniedCapabilities: [], enabled: ['heartbeat'], disabled: [] };
export const origin = (p: PushEventParams) => (p.origin ?? {}) as Record<string, unknown>;

export type PushAnswer = { error?: [number, string]; result?: unknown };

export async function logged(h: { stderr: () => string }, line: string) {
  const deadline = Date.now() + 5_000;
  while (!h.stderr().split('\n').includes(`[heartbeat-mcpl] ${line}`)) {
    assert.ok(Date.now() < deadline, `expected the log line\n${line}\nin\n${h.stderr()}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

export interface ServerFiles { dir: string; reminders: string; config: string; }

export async function serverWithHost(
  answerPush: (p: PushEventParams) => PushAnswer | Promise<PushAnswer>,
  { reminders = [] as unknown[], mcpl = true, policy = true, env = {} as Record<string, string>, prepare = (_files: ServerFiles) => {} } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'hb-scripted-host-'));
  const remindersFile = join(dir, 'reminders.json');
  const files: ServerFiles = { dir, reminders: remindersFile, config: join(dir, 'config.json') };
  writeFileSync(remindersFile, JSON.stringify(reminders));
  prepare(files);
  const child = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'src', 'index.ts'), '--stdio'], {
    cwd: ROOT,
    env: { ...process.env, ...env, HEARTBEAT_CONFIG_FILE: files.config, HEARTBEAT_REMINDERS_FILE: remindersFile },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (b) => { stderr += String(b); });
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
    } catch { }
  })();
  await conn.sendRequest('initialize', {
    protocolVersion: '2024-11-05', capabilities: mcpl ? { experimental: { mcpl: { version: '0.5', pushEvents: true } } } : {},
    clientInfo: { name: 'test-host', version: '0' },
  }, 10_000);
  const request = (method: string, params: unknown) => conn.sendRequest(method, params, 10_000);
  if (mcpl && policy) await request('featureSets/update', POLICY);
  const notify = (method: string, params: unknown) => conn.sendNotification(method, params);
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    ((await conn.sendRequest('tools/call', { name, arguments: args }, 10_000)) as { content: Array<{ text: string }> }).content[0]!.text;
  const pushCount = async (n: number, within = 5_000) => {
    const deadline = Date.now() + within;
    while (pushes.length < n) {
      assert.ok(Date.now() < deadline, `expected ${n} push/event(s), saw ${pushes.length}`);
      await new Promise<void>((r) => { pushWaiters.push(r); setTimeout(r, 100); });
    }
  };
  const settle = () => new Promise((r) => setTimeout(r, 200));
  const close = () => { conn.close(); child.kill(); rmSync(dir, { recursive: true, force: true }); };
  const hangUp = () => { conn.close(); return exited; };
  const crash = () => { child.kill('SIGKILL'); return exited; };
  const stored = () => JSON.parse(readFileSync(remindersFile, 'utf8')) as Array<Record<string, unknown>>;
  return { pushes, call, request, notify, pushCount, settle, stored, stderr: () => stderr, close, hangUp, crash, files };
}
