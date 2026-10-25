// sendPush says what came of a push/event, in words for the agent, and a push
// the host never answers fails after 30 s, so a reminder waiting on its answer
// can't wait forever.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { McplConnection, RpcError } from '@animalabs/mcpl-core';
import type { PushEventParams } from '@animalabs/mcpl-core';
import { sendPush } from '../src/push.js';
import type { PushOutcome } from '../src/push.js';

const params: PushEventParams = {
  featureSet: 'heartbeat', eventId: 'reminder_1', timestamp: '2026-10-15T12:00:00.000Z',
  origin: { source: 'reminder' }, payload: { content: [{ type: 'text', text: 'hello' }] },
};

/** The server's end of a connection, and the host's end, which answers each
 *  request as `answer` says, or never when it returns undefined. */
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
    } catch { /* closed */ }
  })();
  return { server, host, close: () => { host.close(); server.close(); } };
}

/** The errors `conn`'s requests reject with, as mcpl-core gives them. */
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

/** mcpl-core 0.2 starts an RpcError's message with "RPC error <code>: ". */
function failedWith(error: Error): string {
  const why = error instanceof RpcError ? error.message.replace(`RPC error ${error.code}: `, '') : error.message;
  return `the push failed: ${why}`;
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
  // The connection's own default is no timeout here, so only the bound that
  // sendPush gives can end the wait, whatever mcpl-core's default is.
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
  assert.equal(outcome.refusal, failedWith(seen[0]));
});

test('a push out when the connection closes fails', async (t) => {
  // The clock stands still, so the push's 30 s bound can't end it: only the close can.
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
  assert.equal(outcome.refusal, failedWith(seen[0]));
});
