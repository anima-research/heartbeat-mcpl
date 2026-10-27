import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { McplConnection } from '@animalabs/mcpl-core';
import type { PushEventParams } from '@animalabs/mcpl-core';
import { sendPush } from '../src/push.js';
import type { PushOutcome } from '../src/push.js';

const params: PushEventParams = {
  featureSet: 'heartbeat', eventId: 'reminder_1', timestamp: '2026-10-15T12:00:00.000Z',
  origin: { source: 'reminder' }, payload: { content: [{ type: 'text', text: 'hello' }] },
};

function connected(answer: () => { error?: [number, string]; result?: unknown } | undefined) {
  const toHost = new PassThrough();
  const toServer = new PassThrough();
  const server = McplConnection.fromStreams(toServer, toHost);
  const host = McplConnection.fromStreams(toHost, toServer);
  void (async () => {
    try {
      for (;;) {
        const msg = await host.nextMessage();
        if (msg.type !== 'request') continue;
        const a = answer();
        if (a?.error) host.sendError(msg.request.id, ...a.error);
        else if (a) host.sendResponse(msg.request.id, a.result);
      }
    } catch { }
  })();
  return { server, host, close: () => { host.close(); server.close(); } };
}

function rejections(conn: McplConnection): Error[] {
  const seen: Error[] = [];
  const send = conn.sendRequest.bind(conn);
  conn.sendRequest = ((...args: Parameters<typeof send>) => {
    const sent = send(...args);
    sent.catch((e: Error) => { seen.push(e); });
    return sent;
  }) as typeof conn.sendRequest;
  return seen;
}


/** setImmediate isn't among the timers these tests mock, so this runs promise callbacks and I/O without moving the clock. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('each answer is told apart: taken, refused with or without a reason, or an error; only accepted: false refuses', async (t) => {
  const cases: Array<[string, { error?: [number, string]; result?: unknown }, string | null]> = [
    ['taken', { result: { accepted: true, inferenceId: 'i' } }, null],
    ['an answer that says nothing of accepted', { result: {} }, null],
    ['a null answer', { result: null }, null],
    ['refused with a reason', { result: { accepted: false, reason: 'busy' } }, 'the host refused it: busy'],
    ['refused without one', { result: { accepted: false } }, 'the host refused it'],
    ['an error answer', { error: [-32001, 'Feature set not enabled: heartbeat'] }, 'the push failed: Feature set not enabled: heartbeat'],
  ];
  for (const [name, answer, refusal] of cases) {
    const c = connected(() => answer);
    t.after(c.close);
    assert.equal((await sendPush(c.server, params)).refusal, refusal, name);
  }
});

test('a push the host never answers fails at 30 s, and not before', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const c = connected(() => undefined);
  t.after(c.close);
  c.server.requestTimeout = 0;
  const seen = rejections(c.server);
  const outcomes: PushOutcome[] = [];
  void sendPush(c.server, params).then((o) => { outcomes.push(o); });
  await flush();
  t.mock.timers.tick(29_999);
  await flush();
  assert.equal(outcomes.length, 0, 'still waiting a millisecond before 30 s');
  t.mock.timers.tick(1);
  await flush();
  assert.equal(seen.length, 1, 'the push failed at 30 s');
  const [outcome] = outcomes;
  assert.ok(outcome && 'error' in outcome, 'it came back as a failure');
  assert.equal(outcome.error, seen[0]);
  assert.equal(outcome.refusal, "the host didn't answer within 30 s, so whether it was delivered is unknown");
});

test('a push out when the connection closes fails', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const c = connected(() => undefined);
  const seen = rejections(c.server);
  const outcomes: PushOutcome[] = [];
  void sendPush(c.server, params).then((o) => { outcomes.push(o); });
  await flush();
  c.close();
  for (let i = 0; i < 10 && outcomes.length === 0; i++) await flush();
  assert.equal(outcomes.length, 1, 'the push came back at the close, with no time passing');
  assert.equal(seen.length, 1, 'the push failed when the connection closed');
  const [outcome] = outcomes;
  assert.ok('error' in outcome, 'it came back as a failure');
  assert.equal(outcome.error, seen[0]);
  assert.equal(outcome.refusal, `the push failed: ${seen[0]!.message}`);
});
