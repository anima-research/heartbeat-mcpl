// A reminder changes only when the host answers its push. Taken, a one-shot is
// removed and a recurring one advances; refused, or failed, it is held: listed
// with the reason and when, not asked again on every fire, and tried once more
// at the next policy update, add, cancel or restart, and a recurring one also
// an interval after the refusal. Until the host takes it, the file holds it as
// it was. Before, it was removed or advanced as soon as its push went out, so a
// refused push lost it with only a log line.
import test from 'node:test';
import assert from 'node:assert/strict';
import { POLICY, logged, origin, serverWithHost } from './scripted-host.js';
import type { PushAnswer } from './scripted-host.js';

type Host = Awaited<ReturnType<typeof serverWithHost>>;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const row = (id: string, fireAt: number, everySeconds: number | null) => ({ id, message: id, createdAt: fireAt - 60_000, fireAt, everySeconds });
const refusedLine = 'A reminder whose push was refused or failed is tried again when the host next updates its settings, '
  + 'when a reminder is added or cancelled, or when the server restarts, and a recurring one also an interval after it was refused or failed.';

/** reminder_list once it matches `pattern`: the server reads a push's answer
 *  after the host sends it, so what the answer changes shows a little later. */
async function listed(h: Host, pattern: RegExp): Promise<string> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const list = await h.call('reminder_list');
    if (pattern.test(list)) return list;
    assert.ok(Date.now() < deadline, `reminder_list never matched ${pattern}:\n${list}`);
    await sleep(50);
  }
}

/** When reminder_list says the reminder `id` was refused, in epoch ms. */
function refusedAt(list: string, id: string): number {
  const m = new RegExp(`^${id} \\| .*, at (\\S+) \\[[^\\]]+\\]\\) \\|`, 'm').exec(list);
  assert.ok(m, `no refusal time for ${id}:\n${list}`);
  return Date.parse(m[1]!);
}

test('a one-shot whose push fails is held, listed with the reason and when, and tried once more when a reminder is added', async (t) => {
  let refuse = true;
  const startedAt = Date.now();
  const seeded = row('rem_once', startedAt - 1000, null);
  const h = await serverWithHost((p) => (refuse && origin(p).source === 'reminder'
    ? { error: [-32001, 'Feature set not enabled: heartbeat'] } : {}), { reminders: [seeded] });
  t.after(h.close);
  await h.pushCount(1);
  const list = await listed(h, /\(overdue; the push failed: /);
  const listedAt = Date.now();
  // Long enough for a reminder re-armed after its refusal to have been tried again many times.
  await sleep(500);
  assert.equal(h.pushes.length, 1, 'tried once, not again on every fire');
  assert.match(list, /^rem_once \| next .* \(overdue; the push failed: Feature set not enabled: heartbeat, at [^)]+\) \| one-shot \| "rem_once"$/m);
  assert.ok(list.endsWith(`\n${refusedLine}`), list);
  // A one-shot has no interval to wait for, so its line ends at the triggers.
  await logged(h, 'reminder rem_once: the push failed: Feature set not enabled: heartbeat; '
    + 'holding it until the next policy update, add, cancel or restart');
  // To the second, so a time from before the server started (such as the due time) can't pass.
  const at = refusedAt(list, 'rem_once');
  assert.ok(at >= Math.floor(startedAt / 1000) * 1000 && at <= listedAt, `listed as refused when the answer came (${at - startedAt} ms after the start)`);
  assert.deepEqual(h.stored(), [seeded], 'the file holds it as it was');

  refuse = false;
  await h.call('reminder_add', { message: 'later', inHours: 1 });
  await h.pushCount(2);
  assert.equal(origin(h.pushes[1]!).reminderId, 'rem_once', 'tried again once a reminder is added');
  const after = await listed(h, /^1 reminder\(s\):/);
  assert.doesNotMatch(after, /rem_once/, 'and gone once the host took it');
  assert.doesNotMatch(after, /refused or failed/);
});

test('a recurring reminder whose push the host refuses stays at its due time, and is tried again at the next policy', async (t) => {
  let refuse = true;
  const fireAt = Date.now() - 1000;
  const seeded = row('rem_hourly', fireAt, 3600);
  const h = await serverWithHost((p) => (refuse && origin(p).source === 'reminder'
    ? { result: { accepted: false, reason: 'busy' } } : {}), { reminders: [seeded] });
  t.after(h.close);
  await h.pushCount(1);
  assert.match(await listed(h, /the host refused it/), /^rem_hourly \| next .* \(overdue; the host refused it: busy, at [^)]+\) \| repeats every 3600s/m);
  assert.deepEqual(h.stored(), [seeded], 'the file holds it as it was, not advanced');

  refuse = false;
  await h.request('featureSets/update', POLICY);
  await h.pushCount(2);
  await listed(h, /^rem_hourly \| next .* \(~\d+s\)/m);
  assert.deepEqual(h.stored(), [{ ...seeded, fireAt: fireAt + 3_600_000 }], 'taken, it is next due an hour after the time the host refused');
});

test('a recurring reminder the host refuses is tried again an interval after each refusal, with nothing else happening, and goes on once taken', async (t) => {
  // When each push reached the host. The server reads the host's answer after
  // this, so a time the code counts an interval from comes later.
  const arrived: number[] = [];
  const fireAt = Date.now() - 1000;
  const seeded = row('rem_5s', fireAt, 5);
  // Refused at its first push and at its first retry, then taken.
  const h = await serverWithHost((p) => {
    if (origin(p).source !== 'reminder') return {};
    arrived.push(Date.now());
    return arrived.length <= 2 ? { result: { accepted: false, reason: 'busy' } } : {};
  }, { reminders: [seeded] });
  t.after(h.close);
  await h.pushCount(1);
  await listed(h, /^rem_5s \| next .* \(overdue; the host refused it: busy, at [^)]+\) \| repeats every 5s/m);
  await logged(h, 'reminder rem_5s: the host refused it: busy; '
    + 'holding it until the next policy update, add, cancel or restart, or for its interval, 5s');
  assert.deepEqual(h.stored(), [seeded], 'refused, the file holds it as it was');
  // No policy update, add, cancel or restart: only its interval brings it back,
  // and once taken it goes on an interval after the take, not at once.
  await h.pushCount(4, 25_000);
  const gaps = arrived.slice(1, 4).map((at, n) => at - arrived[n]!);
  for (const [n, gap] of gaps.entries()) {
    assert.ok(gap >= 5_000 && gap < 9_000, `push ${n + 2} came ${gap} ms after push ${n + 1}, not an interval: ${gaps}`);
  }
  assert.ok(h.pushes.every((p) => origin(p).reminderId === 'rem_5s'));
  // Listed as next due, the last push is settled and saved: the file is
  // written in place, so a read while the take is still being saved can catch
  // it half written.
  const after = await listed(h, /^rem_5s \| next .* \(~\d+s\) \| repeats every 5s/m);
  assert.doesNotMatch(after, /refused|failed/, 'taken, its refusal is gone');
  assert.notEqual((h.stored()[0] as { fireAt: number }).fireAt, fireAt, 'and it has advanced in the file');
});

test('a recurring reminder whose next time is past the last one ends only once the host takes its push', async (t) => {
  let refuse = true;
  const seeded = row('rem_last', Date.now() - 1000, 1e13);
  const h = await serverWithHost(() => (refuse ? { result: { accepted: false, reason: 'busy' } } : {}), { reminders: [seeded] });
  t.after(h.close);
  await h.pushCount(1);
  await listed(h, /^rem_last \| .*the host refused it: busy/m);
  assert.deepEqual(h.stored(), [seeded], 'refused, the file holds it as it was');
  assert.doesNotMatch(h.stderr(), /ended recurring reminder/, 'refused, it has not ended');

  refuse = false;
  await h.request('featureSets/update', POLICY);
  await h.pushCount(2);
  await listed(h, /^No reminders set\.$/);
  assert.deepEqual(h.stored(), [], 'taken, it ends, and the file leaves it out');
  assert.ok(h.stderr().includes(`ended recurring reminder ${JSON.stringify(seeded)}: `), `its row in the log:\n${h.stderr()}`);
});

test('a refused reminder is tried once more at a Notification and at a cancel, not at a malformed Notification, and a malformed Request clears its refusal', async (t) => {
  const fireAt = Date.now() - 1000;
  const h = await serverWithHost((p) => (origin(p).reminderId === 'rem_once' ? { result: { accepted: false, reason: 'busy' } } : {}),
    { reminders: [row('rem_once', fireAt, null), row('rem_other', Date.now() + 3_600_000, null)] });
  t.after(h.close);
  const refusedAgain = async (n: number, why: string) => {
    await h.pushCount(n);
    await listed(h, /^rem_once \| .*\(overdue; the host refused it: busy, at /m);
    assert.equal(h.pushes.length, n, why);
  };
  await refusedAgain(1, 'pushed once at the start');
  h.notify('featureSets/update', POLICY);
  await refusedAgain(2, 'tried again at a Notification');
  await h.call('reminder_cancel', { id: 'rem_other' });
  await refusedAgain(3, 'and at a cancel');
  // A malformed Notification is ignored, so it updates nothing and retries nothing.
  h.notify('featureSets/update', { ...POLICY, enabled: 'heartbeat' });
  assert.match(await h.call('reminder_list'), /^rem_once \| .*\(overdue; the host refused it: busy, at /m, 'still refused after a malformed Notification');
  // Long enough for a reminder re-armed by it to have been pushed.
  await sleep(300);
  assert.equal(h.pushes.length, 3, 'and not pushed again');
  await assert.rejects(h.request('featureSets/update', { ...POLICY, enabled: 'heartbeat' }));
  // No wake can be delivered under a malformed policy, so it waits for one, like any due reminder.
  assert.match(await h.call('reminder_list'), /^rem_once \| next .* \(overdue\) \| one-shot/m, 'a malformed Request is a policy update too');
  assert.equal(h.pushes.length, 3);
});

test('until the host answers, a reminder is sent and waiting, and unchanged in the file; one cancelled meanwhile stays gone', async (t) => {
  const answer = new Map<string, (a: PushAnswer) => void>();
  const fireAt = Date.now() - 1000;
  const rows = [row('rem_once', fireAt, null), row('rem_hourly', fireAt, 3600)];
  const h = await serverWithHost((p) => {
    const id = String(origin(p).reminderId);
    return rows.some((r) => r.id === id) ? new Promise<PushAnswer>((resolve) => answer.set(id, resolve)) : {};
  }, { reminders: rows });
  t.after(h.close);
  await h.pushCount(2);
  // One that falls due while those two are out is pushed, and they aren't again.
  await h.call('reminder_add', { message: 'later', atIso: new Date(Date.now() + 1000).toISOString() });
  await h.pushCount(3);
  // Long enough for a reminder re-armed while its push is out to have been pushed many times.
  await sleep(500);
  assert.deepEqual(h.pushes.map((p) => origin(p).reminderId).slice(0, 2), ['rem_once', 'rem_hourly']);
  assert.equal(h.pushes.length, 3, 'each is pushed once while its answer is awaited, a later fire included');
  const list = await h.call('reminder_list');
  assert.match(list, /^rem_once \| next .* \(sent, waiting for the host's answer\) \| one-shot/m);
  assert.match(list, /^rem_hourly \| next .* \(sent, waiting for the host's answer\) \| repeats every 3600s/m);
  assert.deepEqual(h.stored().filter((r) => r.id !== origin(h.pushes[2]!).reminderId), rows, 'the file holds both as they were');

  await h.call('reminder_cancel', { id: 'rem_once' });
  answer.get('rem_once')!({});
  answer.get('rem_hourly')!({});
  await listed(h, /^rem_hourly \| next .* \(~\d+s\)/m);
  assert.doesNotMatch(await h.call('reminder_list'), /rem_once/, 'cancelled while its push was out, the host taking it changes nothing');
  assert.deepEqual(h.stored(), [{ ...rows[1]!, fireAt: fireAt + 3_600_000 }], 'taken, the recurring one advances from its own time');
  assert.equal(h.pushes.length, 3);
  // Read once the server has gone and its log has all been read.
  await h.hangUp();
  assert.doesNotMatch(h.stderr(), /handling the host's answer/, 'and answering it throws nothing');
});

test('a crash with one push out and one refused loses neither: the next start tries both again', async (t) => {
  const fireAt = Date.now() - 1000;
  const rows = [row('rem_out', fireAt, null), row('rem_refused', fireAt, 3600)];
  const first = await serverWithHost((p) => (origin(p).reminderId === 'rem_refused'
    ? { result: { accepted: false, reason: 'busy' } } : new Promise<PushAnswer>(() => {})), { reminders: rows });
  t.after(first.close);
  await first.pushCount(2);
  await listed(first, /^rem_refused \| .*the host refused it: busy/m);
  await first.crash();
  const left = first.stored();
  assert.deepEqual(left, rows, 'the file holds both as they were');

  const second = await serverWithHost(() => ({}), { reminders: left });
  t.after(second.close);
  await second.pushCount(2);
  assert.deepEqual(second.pushes.map((p) => origin(p).reminderId).sort(), ['rem_out', 'rem_refused'], 'both fire at the next start');
  await listed(second, /^1 reminder\(s\):\nrem_refused \| next .* \(~\d+s\)/);
  assert.deepEqual(second.stored(), [{ ...rows[1]!, fireAt: fireAt + 3_600_000 }], 'and once taken, the one-shot is gone and the recurring one advances');
  assert.equal(second.pushes.length, 2, 'each was pushed once');
});

test('a host that goes away while a push is out loses no reminder, and leaves nothing armed, so the server exits', async (t) => {
  const fireAt = Date.now() - 1000;
  const rows = [row('rem_due', fireAt, null), row('rem_later', Date.now() + 60_000, null)];
  const h = await serverWithHost((p) => (origin(p).reminderId === 'rem_due' ? new Promise<PushAnswer>(() => {}) : {}), { reminders: rows });
  t.after(h.close);
  await h.pushCount(1);
  const exitedAt = await Promise.race([h.hangUp().then(() => 'exited'), sleep(5000).then(() => 'still running')]);
  // Armed for rem_later with no host to send to, the process would wait for it,
  // and once it fell due, wake every millisecond from then on.
  assert.equal(exitedAt, 'exited', 'the server exits once its host has gone');
  assert.doesNotMatch(h.stderr(), /handling the host's answer/, 'and settles the push that was out without a throw');
  assert.deepEqual(h.stored(), rows, 'both are in the file as they were, so the next start fires rem_due again');
});
