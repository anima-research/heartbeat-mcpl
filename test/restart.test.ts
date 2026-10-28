import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import type { PushEventParams } from '@animalabs/mcpl-core';
import { POLICY, origin } from './scripted-host.js';
import { serverInProcess, useClock } from './in-process-host.js';

const ASK = " If that doesn't change, ask whoever runs this host.";
const NOT_READY_REASON = "the host hasn't finished setting this server up, or its last settings message was malformed";
const NOT_READY = `No wake can be delivered now, because ${NOT_READY_REASON}. A reminder that falls due waits until one can.${ASK}`;
const NOT_READY_ONE = `No wake can be delivered now, because ${NOT_READY_REASON}, so it waits until one can.${ASK}`;
const DENIED = "No wake can be delivered now, because the host hasn't granted this server what its wakes need. "
  + `A reminder that falls due waits until one can.${ASK}`;
const PRE_05 = "No wake can be delivered on this host, because the host set this server up in an older form that can't turn "
  + "wakes on, so no reminder will fire here. Calling again won't change that; ask whoever runs this host if you need wakes.";

type Fired = PushEventParams & { at: number };

async function start(t: TestContext, rows: unknown[] = []) {
  const pushes: Fired[] = [];
  const h = await serverInProcess(t, (p) => {
    if (origin(p).source === 'reminder') pushes.push({ ...p, at: Date.now() });
    return {};
  }, { reminders: rows, policy: false });
  const list = () => h.call('reminder_list');
  return { h, pushes, list, stored: () => h.stored() };
}

test('an overdue reminder waits until its wake can be delivered, then fires once', async (t) => {
  useClock(t);
  const now = Date.now();
  const row = (id: string, fireAt: number, everySeconds: number | null) => ({ id, message: id.toUpperCase(), createdAt: now - 600_000, fireAt, everySeconds });
  const { h, pushes, list, stored } = await start(t, [
    row('rem_once', now - 120_000, null),
    row('rem_hourly', now - 120_000, 3600),
    row('rem_minutely', now - 600_000, 60),
    row('rem_doomed', now + 3_600_000, null),
  ]);
  const fired = () => pushes.map((p) => origin(p).reminderId as string).sort();
  const lastLine = async () => (await list()).split('\n').pop();

  assert.equal(await lastLine(), NOT_READY, 'with no policy yet, reminder_list says why reminders wait');
  h.notify('featureSets/update', POLICY);
  assert.equal(await lastLine(), PRE_05, 'after a Notification-form update alone, that none will fire on this host');
  await assert.rejects(h.request('featureSets/update', { ...POLICY, enabled: 'heartbeat' }), { code: -32602 });
  assert.equal(await lastLine(), NOT_READY, 'and after a malformed Request, since a host that sends Requests speaks 0.5, that they wait');
  const added = await h.call('reminder_add', { message: 'NEW', inSeconds: 1 });
  const addedId = /Reminder (rem_\S+) set/.exec(added)?.[1];
  assert.ok(addedId, added);
  assert.ok(added.endsWith(` ${NOT_READY_ONE}`), `reminder_add says it waits: ${added}`);
  await h.call('reminder_cancel', { id: 'rem_doomed' });
  await h.request('featureSets/update', { ...POLICY, effectiveCapabilities: ['tools'] });
  await h.advance(2000);
  assert.deepEqual(fired(), [], 'nothing fires while no wake can be delivered');
  const held = await list();
  assert.match(held, /^rem_once \| due .* \(overdue\) \| one-shot \| "REM_ONCE"$/m, 'reminder_list shows the one-shot overdue');
  assert.equal(held.split('\n').pop(), DENIED, 'and says why it waits');
  const waiting = stored();
  assert.deepEqual(waiting.map((r) => r.id).sort(), [addedId, 'rem_hourly', 'rem_minutely', 'rem_once'].sort(), 'nothing is dropped meanwhile');
  assert.deepEqual(waiting.filter((r) => r.id !== addedId).map((r) => r.fireAt), [now - 120_000, now - 120_000, now - 600_000], 'nor advanced');

  const allowedAt = Date.now();
  await h.request('featureSets/update', POLICY);
  await h.until(() => pushes.length >= 4, () => `expected 4 reminders to fire, saw ${fired()}`);
  await h.advance(500);
  assert.deepEqual(fired(), [addedId, 'rem_hourly', 'rem_minutely', 'rem_once'].sort(), 'each fires once the policy allows wakes');
  const text = (id: string) => (pushes.find((p) => origin(p).reminderId === id)!.payload.content[0] as { text: string }).text;
  assert.match(text('rem_once'), /^\[reminder rem_once, set [^\]]+\], due /, 'one two minutes late says when it was due');
  assert.doesNotMatch(text(addedId), /, due /, 'one less than a minute late does not');
  assert.doesNotMatch(await list(), /No wake can be delivered/, 'reminder_list says nothing of waiting once wakes are allowed');
  const after = stored();
  assert.deepEqual(after.map((r) => r.id).sort(), ['rem_hourly', 'rem_minutely']);
  assert.equal(after.find((r) => r.id === 'rem_hourly')!.fireAt, now - 120_000 + 3_600_000,
    'the hourly one is next due an hour after the time it missed');
  const minutely = after.find((r) => r.id === 'rem_minutely')!.fireAt as number;
  assert.equal(minutely, allowedAt + 60_000,
    `the one that missed ten periods is next due a period from when it fired, not from the time it missed (${minutely - allowedAt} ms)`);
});

test('a policy change that stops wakes holds a reminder already armed, until wakes are allowed again', async (t) => {
  useClock(t);
  const { h, pushes, list, stored } = await start(t);
  await h.request('featureSets/update', POLICY);
  for (const [name, stop] of [
    ['a malformed Request', () => assert.rejects(h.request('featureSets/update', { ...POLICY, enabled: 'heartbeat' }), { code: -32602 })],
    ['a Notification that narrows the grant', () => h.notify('featureSets/update', { ...POLICY, effectiveCapabilities: ['tools'] })],
    ['a Request that denies wakes', () => h.request('featureSets/update', { ...POLICY, effectiveCapabilities: ['tools'] })],
  ] as const) {
    const added = await h.call('reminder_add', { message: name, inSeconds: 3 });
    const id = /Reminder (rem_\S+) set/.exec(added)?.[1];
    const dueAt = stored().find((r) => r.id === id)!.fireAt as number;
    await stop();
    await list();
    await h.advance(Math.max(0, dueAt + 500 - Date.now()));
    assert.match(await list(), new RegExp(`^${id} \\| due .* \\(overdue\\) \\| one-shot`, 'm'), `held, overdue, after ${name}`);
    const allowedAt = Date.now();
    await h.request('featureSets/update', POLICY);
    await h.until(() => pushes.some((p) => origin(p).reminderId === id), () => `${id} never fired after ${name}`);
    await h.advance(200);
    assert.deepEqual(pushes.filter((p) => origin(p).reminderId === id).map((p) => p.at >= allowedAt), [true],
      `it fires once, and only once wakes are allowed again, after ${name}`);
  }
});
