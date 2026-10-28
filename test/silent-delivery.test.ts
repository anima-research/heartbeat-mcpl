import test from 'node:test';
import assert from 'node:assert/strict';
import { RpcError } from '@animalabs/mcpl-core';
import type { PushEventParams } from '@animalabs/mcpl-core';
import { INVALID_PARAMS, isEmptyPushRejection, sendSilentWithFallback } from '../src/silent-delivery.js';
import { origin } from './scripted-host.js';
import { serverInProcess, useClock } from './in-process-host.js';

const params = (eventId: string, content: PushEventParams['payload']['content']): PushEventParams => ({
  featureSet: 'heartbeat', eventId, timestamp: '2026-10-06T00:00:00Z',
  origin: { source: 'heartbeat' }, payload: { content },
});

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

test('end to end: a host refusing the empty push gets the tick in message mode, explained once', async (t) => {
  useClock(t);
  const h = await serverInProcess(t, (p) => (p.payload.content.length === 0
    ? { error: [INVALID_PARAMS, 'content has no visible content'] } : {}));
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
  await h.advance(200);
  assert.equal(h.pushes[2]!.payload.content.length, 0, 'every tick tries silent first');
  assert.equal(h.pushes[3]!.payload.content.length, 1);
  assert.equal(h.stderr().match(/WARNING: the host refused the silent heartbeat/g)?.length, 1, 'explained once per process');
  assert.match(h.stderr(), /WARNING: the host refused the silent heartbeat as an empty push \(content has no visible content\)\./, 'with the host\'s reason');
  assert.match(await h.call('heartbeat_status'), /mode=silent \(the host refused a silent wake, which carries no text, so heartbeats arrive as messages\. Setting deliveryMode again won't change that; ask whoever runs this host if you need them silent\) \|/);
});

test('end to end: a host that accepts the silent marker gets no fallback', async (t) => {
  useClock(t);
  const h = await serverInProcess(t, () => ({}));
  await h.call('heartbeat_configure', { deliveryMode: 'silent' });
  await h.call('heartbeat_trigger');
  await h.pushCount(1);
  await h.advance(200);
  assert.equal(h.pushes.length, 1);
  assert.deepEqual(h.pushes[0]!.payload.content, []);
  assert.doesNotMatch(h.stderr(), /WARNING: the host refused/);
  assert.match(await h.call('heartbeat_status'), /mode=silent \|/);
});

test('in silent mode a trigger is an empty push carrying the server-authored silent marker, and reminders still carry their message', async (t) => {
  useClock(t);
  const h = await serverInProcess(t, () => ({}));
  await h.call('heartbeat_configure', { deliveryMode: 'silent', paused: false });
  assert.ok((await h.call('heartbeat_status')).includes('mode=silent'), 'status reports silent mode');
  await h.call('heartbeat_trigger');
  await h.until(() => h.pushes.some((p) => origin(p).source === 'heartbeat'), () => 'no heartbeat push');
  const hb = h.pushes.find((p) => origin(p).source === 'heartbeat')!;
  assert.equal(origin(hb).silent, true, 'silent marker is server-authored');
  assert.ok(Array.isArray(hb.payload?.content) && hb.payload.content.length === 0, 'silent push has no message content');

  await h.call('reminder_add', { message: 'REMINDER-TEXT', inSeconds: 5 });
  await h.advance(5000);
  await h.until(() => h.pushes.some((p) => origin(p).source === 'reminder'), () => 'reminder never fired in silent mode');
  const rem = h.pushes.find((p) => origin(p).source === 'reminder')!;
  const remText = (rem.payload?.content?.[0] as { text?: string } | undefined)?.text ?? '';
  assert.ok(remText.startsWith('[reminder ') && remText.endsWith('] REMINDER-TEXT'), 'reminders remain message-bearing');
});
