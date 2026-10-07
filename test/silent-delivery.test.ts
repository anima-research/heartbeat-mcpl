// Silent heartbeat delivery falls back to message mode when the host refuses
// the empty silent push (-32602): a host without silent wakes, or this server
// configured under an id other than `heartbeat`. Unit tests for the helper,
// then an end-to-end run of the server against a scripted host.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McplConnection, RpcError } from '@animalabs/mcpl-core';
import type { PushEventParams } from '@animalabs/mcpl-core';
import { INVALID_PARAMS, isEmptyPushRejection, sendSilentWithFallback } from '../src/silent-delivery.js';

const params = (eventId: string, content: PushEventParams['payload']['content']): PushEventParams => ({
  featureSet: 'heartbeat', eventId, timestamp: '2026-10-06T00:00:00Z',
  origin: { source: 'heartbeat' }, payload: { content },
});

// ── isEmptyPushRejection ──

test('a -32602 error, or accepted:false naming empty content, is an empty-push rejection', () => {
  assert.equal(isEmptyPushRejection({ error: new RpcError(INVALID_PARAMS, 'content has no visible content') }), true);
  assert.equal(isEmptyPushRejection({ result: { accepted: false, reason: 'empty-content' } }), true);
});

test('other outcomes are not', () => {
  assert.equal(isEmptyPushRejection({ error: new RpcError(-32001, 'Feature set not enabled: heartbeat') }), false);
  assert.equal(isEmptyPushRejection({ error: new Error('connection closed') }), false);
  assert.equal(isEmptyPushRejection({ result: { accepted: true, inferenceId: 'i' } }), false);
  assert.equal(isEmptyPushRejection({ result: { accepted: false, reason: 'duplicate' } }), false);
  assert.equal(isEmptyPushRejection({ result: undefined }), false);
});

// ── sendSilentWithFallback ──

test('an accepted silent push is not followed by a fallback', async () => {
  const sent: PushEventParams[] = [];
  const out = await sendSilentWithFallback(
    async (p) => { sent.push(p); return { accepted: true }; },
    params('s', []), () => params('m', [{ type: 'text', text: 'tick' }]),
  );
  assert.equal(out.delivered, 'silent');
  assert.deepEqual(sent.map((p) => p.eventId), ['s']);
});

test('a -32602 rejection re-sends the tick in message mode under a fresh event', async () => {
  const sent: PushEventParams[] = [];
  const out = await sendSilentWithFallback(
    async (p) => {
      sent.push(p);
      if (p.payload.content.length === 0) throw new RpcError(INVALID_PARAMS, 'content has no visible content');
      return { accepted: true, inferenceId: 'i' };
    },
    params('s', []), () => params('m', [{ type: 'text', text: 'tick' }]),
  );
  assert.equal(out.delivered, 'message');
  assert.deepEqual(out.result, { accepted: true, inferenceId: 'i' });
  assert.match((out as { rejection: string }).rejection, /no visible content/);
  assert.deepEqual(sent.map((p) => p.eventId), ['s', 'm']);
});

test('a legacy accepted:false empty-content result also falls back', async () => {
  const sent: string[] = [];
  const out = await sendSilentWithFallback(
    async (p) => { sent.push(p.eventId); return p.eventId === 's' ? { accepted: false, reason: 'empty-content' } : { accepted: true }; },
    params('s', []), () => params('m', [{ type: 'text', text: 'tick' }]),
  );
  assert.equal(out.delivered, 'message');
  assert.deepEqual(sent, ['s', 'm']);
});

test('any other failure is not papered over with a fallback', async () => {
  const sent: string[] = [];
  await assert.rejects(sendSilentWithFallback(
    async (p) => { sent.push(p.eventId); throw new RpcError(-32001, 'Feature set not enabled: heartbeat'); },
    params('s', []), () => params('m', [{ type: 'text', text: 'tick' }]),
  ), /Feature set not enabled/);
  assert.deepEqual(sent, ['s']);
});

// ── end to end: the server against a scripted host ──

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const origin = (p: PushEventParams) => (p.origin ?? {}) as Record<string, unknown>;

async function serverWithHost(answerPush: (p: PushEventParams) => { error?: [number, string]; result?: unknown }) {
  const dir = mkdtempSync(join(tmpdir(), 'hb-silent-fallback-'));
  const child = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'src', 'index.ts'), '--stdio'], {
    cwd: ROOT,
    env: { ...process.env, HEARTBEAT_CONFIG_FILE: join(dir, 'config.json'), HEARTBEAT_REMINDERS_FILE: join(dir, 'reminders.json') },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (b) => { stderr += String(b); });
  const conn = McplConnection.fromStreams(child.stdout, child.stdin);
  const pushes: PushEventParams[] = [];
  const pushWaiters: Array<() => void> = [];
  void (async () => {
    try {
      for (;;) {
        const msg = await conn.nextMessage();
        if (msg.type !== 'request' || msg.request.method !== 'push/event') continue;
        const p = msg.request.params as PushEventParams;
        pushes.push(p);
        const answer = answerPush(p);
        if (answer.error) conn.sendError(msg.request.id, ...answer.error);
        else conn.sendResponse(msg.request.id, answer.result ?? { accepted: true, inferenceId: 'i' });
        pushWaiters.splice(0).forEach((w) => w());
      }
    } catch { /* closed */ }
  })();
  await conn.sendRequest('initialize', {
    protocolVersion: '2024-11-05', capabilities: { experimental: { mcpl: { version: '0.5', pushEvents: true } } },
    clientInfo: { name: 'test-host', version: '0' },
  }, 10_000);
  await conn.sendRequest('featureSets/update', {
    effectiveCapabilities: ['tools', 'pushEvents'], deniedCapabilities: [], enabled: ['heartbeat'], disabled: [],
  }, 10_000);
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    ((await conn.sendRequest('tools/call', { name, arguments: args }, 10_000)) as { content: Array<{ text: string }> }).content[0]!.text;
  const pushCount = async (n: number) => {
    const deadline = Date.now() + 5_000;
    while (pushes.length < n) {
      assert.ok(Date.now() < deadline, `expected ${n} push/event(s), saw ${pushes.length}`);
      await new Promise<void>((r) => { pushWaiters.push(r); setTimeout(r, 100); });
    }
  };
  // Let the response to the last push be read and logged by the server.
  const settle = () => new Promise((r) => setTimeout(r, 200));
  const close = () => { conn.close(); child.kill(); rmSync(dir, { recursive: true, force: true }); };
  return { pushes, call, pushCount, settle, stderr: () => stderr, close };
}

test('end to end: a host refusing the empty push gets the tick in message mode, explained once', async (t) => {
  const h = await serverWithHost((p) => (p.payload.content.length === 0
    ? { error: [INVALID_PARAMS, 'content has no visible content'] } : {}));
  t.after(h.close);
  await h.call('heartbeat_configure', { deliveryMode: 'silent', message: 'CHECK-IN' });

  await h.call('heartbeat_trigger');
  await h.pushCount(2);
  const [silent, fallback] = h.pushes;
  assert.deepEqual(silent!.payload.content, []);
  assert.equal(origin(silent!).silent, true);
  assert.equal(fallback!.payload.content[0]?.type, 'text');
  assert.match((fallback!.payload.content[0] as { text: string }).text, /^\[current time: .+\] CHECK-IN$/);
  assert.equal(origin(fallback!).silent, undefined, 'the fallback is an ordinary message');
  assert.equal(origin(fallback!).silentFallback, true);
  assert.notEqual(fallback!.eventId, silent!.eventId);

  await h.call('heartbeat_trigger');
  await h.pushCount(4);
  await h.settle();
  assert.equal(h.pushes[2]!.payload.content.length, 0, 'every tick tries silent first');
  assert.equal(h.pushes[3]!.payload.content.length, 1);
  assert.equal(h.stderr().match(/WARNING: the host refused the silent heartbeat/g)?.length, 1, 'explained once per process');
  assert.match(await h.call('heartbeat_status'), /mode=silent \(host refused the empty silent push; ticks fall back to message mode\)/);
});

test('end to end: a host that accepts the silent marker gets no fallback', async (t) => {
  const h = await serverWithHost(() => ({}));
  t.after(h.close);
  await h.call('heartbeat_configure', { deliveryMode: 'silent' });
  await h.call('heartbeat_trigger');
  await h.pushCount(1);
  await h.settle();
  assert.equal(h.pushes.length, 1);
  assert.deepEqual(h.pushes[0]!.payload.content, []);
  assert.doesNotMatch(h.stderr(), /WARNING: the host refused/);
  assert.match(await h.call('heartbeat_status'), /mode=silent \|/);
});
